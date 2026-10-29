"""Per-problem v1.1 advisory routing, with registered-tool contracts retained.

Package selection semantics are reused verbatim. Profiles from text are explicitly
unverified observations; no condition is promoted to truth and no problem ID,
reference answer, dataset or fixed ODE profile participates in selection.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys
import threading

from .skills import SkillCatalog

_IMPORT_LOCK = threading.Lock()


def _selector(root):
    with _IMPORT_LOCK:
        # A vendored dependency is loaded by a private, content-bound module name.
        name = 'astra_general_v11_select_methods'
        if name not in sys.modules:
            dependency = root / 'scripts/reasoning_contracts.py'
            spec = importlib.util.spec_from_file_location('astra_general_v11_reasoning_contracts', dependency)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            previous = sys.modules.get('reasoning_contracts')
            sys.modules['reasoning_contracts'] = module
            try:
                spec = importlib.util.spec_from_file_location(name, root / 'scripts/select_methods.py')
                selector = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(selector)
                sys.modules[name] = selector
            finally:
                if previous is None:
                    sys.modules.pop('reasoning_contracts', None)
                else:
                    sys.modules['reasoning_contracts'] = previous
        return sys.modules[name]


class GeneralMethodCatalog(SkillCatalog):
    def __init__(self, store):
        super().__init__()
        self.legacy = SkillCatalog()
        self.store = store
        self.general_root = Path(__file__).resolve().parent / 'resources/general_v11'
        self.selector = _selector(self.general_root)
        self.methods = self.selector.load_registry(self.general_root)
        self.bodies = {}
        self._method_lock = threading.RLock()
        self.identity = json.loads((self.general_root / 'SOURCE.json').read_text(encoding='utf-8'))
        self.store.control['general_method_layer'] = {
            'version': '1.1.0', 'package_sha256': self.identity['package_sha256'],
            'selection': 'model-suggested IDs and observed mathematical vocabulary; unverified',
            'fixed_ode_profile': False, 'distinct_loaded': [], 'loads': [],
        }

    def metadata(self):
        methods = '\n'.join(f"{mid}: {m['title']}" for mid, m in self.methods.items())
        return (super().metadata() + '\nGeneral v1.1 method IDs (advisory, not tools):\n' + methods
                + '\nFIELDS may name these method IDs when appropriate. Read original conditions first; '
                  'state method prerequisites, unknown premises and the expected intermediate result. '
                  'No matching method is a normal direct-reasoning path, not a refusal.')

    def _profile(self, goal, suggestions, context):
        text = '\n'.join([self.store.problem.raw, str(goal), *(x for x in context if isinstance(x, str))])
        cues = {
            ('tasks', 'prove'): r'\bprov(?:e|ing)\b|证明',
            ('tasks', 'count'): r'\bcount\b|计数|个数',
            ('tasks', 'solve'): r'\bsolve\b|求解',
            ('tasks', 'compute'): r'\bcompute\b|计算',
            ('objects', 'differential_equation'): r'differential equation|\bODE\b|微分方程',
            ('objects', 'integral'): r'\bintegral\b|\\int\b|积分',
            ('objects', 'matrix'): r'\bmatri(?:x|ces)\b|矩阵',
            ('objects', 'equation'): r'\bequations?\b|方程',
            ('objects', 'graph'): r'\bgraph\b|图论|顶点',
            ('objects', 'sequence'): r'\bsequence\b|数列|递推',
            ('objects', 'function'): r'\bfunctions?\b|函数',
            ('objects', 'integer'): r'\bintegers?\b|整数',
            ('objects', 'probability'): r'\bprobabilit(?:y|ies)\b|概率',
            ('objects', 'triangle'): r'\btriangle\b|三角形',
            ('structures', 'linear_first_order'): r'first.order linear|linear first.order|一阶线性',
            ('structures', 'recurrence'): r'\brecurrence\b|递推',
            ('structures', 'modular_constraints'): r'\bcongruence\b|同余',
        }
        profile = {'tasks': [], 'objects': [], 'structures': [], 'known_conditions': [],
                   'requested_methods': [m for m in suggestions if m in self.methods]}
        evidence = []
        for (field, tag), expression in cues.items():
            match = re.search(expression, text, flags=re.I)
            if match:
                profile[field].append(tag)
                evidence.append({'tag': tag, 'quote': match.group(0)})
        return profile, evidence

    def search(self, text, suggested=(), *, context=()):
        profile, evidence = self._profile(text, suggested, context)
        selection = self.selector.choose(profile, root=self.general_root, loaded=(), max_new=2)
        chosen = tuple(row['id'] for row in selection['selected'])
        # Search itself reads metadata only and cannot promote a claim or consume a method.
        return chosen or super().search(text, suggested, context=context)

    def load_for(self, goal, suggestions=(), *, context=()):
        profile, evidence = self._profile(goal, suggestions, context)
        with self._method_lock:
            state = self.store.control['general_method_layer']
            loaded = set(state['distinct_loaded'])
            ranked = self.selector.choose(profile, root=self.general_root, loaded=(), max_new=2)
            chosen = [row['id'] for row in ranked['selected']]
            # A request is stateless: cache disk reads, never omit the needed prompt body.
            new_allowance = 2 if not loaded else 1
            selected = []
            for mid in chosen:
                if mid in loaded or (new_allowance > 0 and len(loaded) < 5):
                    selected.append(mid)
                    if mid not in loaded:
                        loaded.add(mid)
                        new_allowance -= 1
            state['distinct_loaded'] = sorted(loaded)
            parts = []
            for mid in selected:
                rel = self.methods[mid]['path']
                if mid not in self.bodies:
                    path = self.general_root / rel
                    body = path.read_text(encoding='utf-8')
                    digest = hashlib.sha256(body.encode()).hexdigest()
                    if digest != self.identity['files'][rel]:
                        raise ValueError('general method runtime changed')
                    self.bodies[mid] = (body, digest)
                body, digest = self.bodies[mid]
                row = {'method_id': mid, 'body_sha256': digest, 'profile': profile,
                       'profile_evidence': evidence, 'applicability_proved': False}
                state['loads'].append(row)
                self.store.event('general_method_loaded', **row)
                parts.append(f'[general-v1.1 method={mid}; prerequisites unverified]\n{body}')
            # Existing exact operators remain optional registered capabilities, not answer selectors.
            legacy = self.legacy.load_for(goal, suggestions, context=context)
            if not selected:
                self.store.event('general_method_no_match', status=ranked['status'], direct_reasoning_preserved=True)
            return '\n\n'.join([*parts, legacy] if legacy else parts)
