"""Host-side model-access configuration for the Astra Web BFF.

The credential is *write-only* from the web console's point of view: the console
may submit it, but no response, log line or stored artefact ever returns it. Only
a short SHA-256 fingerprint is exposed, so an operator can tell *which* credential
is in place without being able to read it back.

The file lives on the host, outside the repository, and is reached through the
same entry point the official ``mathagent.user_client.create_client`` factory
reads (``ASTRA_USER_CLIENT_CONFIG``); otherwise it sits under the BFF data root,
which ``.gitignore`` already excludes. Format is deliberately dumb key=value:

    endpoint=https://...
    model=...
    credential=...

Nothing in this module logs, echoes or persists the credential anywhere other
than the configuration file itself.
"""

from __future__ import annotations

import hashlib
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Optional

CONFIG_FILENAME = "user_client.conf"

_KEY_ENDPOINT = "endpoint"
_KEY_MODEL = "model"
_KEY_CREDENTIAL = "credential"
_REQUIRED = (_KEY_ENDPOINT, _KEY_MODEL, _KEY_CREDENTIAL)


class SolverConfigError(ValueError):
    """Raised when a submitted configuration cannot be used."""


@dataclass(frozen=True)
class EndpointSpec:
    """One officially sanctioned model endpoint and the models it serves.

    The web console offers exactly these; a submission naming anything else is
    rejected rather than forwarded to an arbitrary host.
    """

    key: str
    label: str
    url: str
    models: tuple[str, ...]
    client: str  # "intern-chat" routes through the official pinned client


ENDPOINTS: tuple[EndpointSpec, ...] = (
    EndpointSpec(
        key="intern-s2-chat",
        label="书生 · 浦语 Intern-S2（官方对话端点）",
        url="https://chat.intern-ai.org.cn/api/v1/chat/completions",
        models=("Intern-S2-Preview-397B",),
        client="intern-chat",
    ),
    EndpointSpec(
        key="intern-inkstone",
        label="书生 · 端砚 Intern InkStone（discovery 端点，OpenAI 兼容）",
        url="https://discovery-api.intern-ai.org.cn/v1/chat/completions",
        models=("intern-s2",),
        client="openai-compatible",
    ),
)

#: Where the platform reports points/balance. No programmatic API for this was
#: found, so the console links out instead of inventing a number.
BALANCE_LEDGER_URL = "https://discovery.intern-ai.org.cn/token-plan/points?tab=ledger"
KEY_MANAGEMENT_URL = "https://internlm.intern-ai.org.cn/api/tokens"


def endpoint_spec(url: str) -> Optional[EndpointSpec]:
    for spec in ENDPOINTS:
        if spec.url == url:
            return spec
    return None


def endpoint_registry() -> list[dict[str, Any]]:
    """The endpoint/model catalogue handed to the console (no secrets involved)."""
    return [
        {
            "key": spec.key,
            "label": spec.label,
            "url": spec.url,
            "models": list(spec.models),
        }
        for spec in ENDPOINTS
    ]


@dataclass(frozen=True)
class SolverConfig:
    endpoint: str
    model: str
    credential: str
    source: Path

    def fingerprint(self) -> str:
        return credential_fingerprint(self.credential)


def credential_fingerprint(credential: str) -> str:
    """A short, non-reversible identifier for a credential (never the value)."""
    digest = hashlib.sha256(credential.encode("utf-8")).hexdigest()
    return "sha256:" + digest[:12]


def config_path(data_root: os.PathLike[str] | str | None = None) -> Path:
    """Resolve the host-side configuration path.

    ``ASTRA_USER_CLIENT_CONFIG`` wins, because that is the entry point the
    official client factory reads; otherwise the file lives under the data root.
    """
    explicit = os.environ.get("ASTRA_USER_CLIENT_CONFIG")
    if explicit:
        return Path(explicit).expanduser()
    if data_root is None:
        raise SolverConfigError("data_root or ASTRA_USER_CLIENT_CONFIG is required")
    return Path(data_root).expanduser() / CONFIG_FILENAME


def _parse(text: str, source: Path) -> SolverConfig:
    values: dict[str, list[str]] = {key: [] for key in _REQUIRED}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise SolverConfigError("unparsable configuration line (no '=')")
        key, _, value = line.partition("=")
        key = key.strip().lower()
        if key in values:
            values[key].append(value.strip())

    for key in _REQUIRED:
        if len(values[key]) != 1:
            raise SolverConfigError(
                "configuration must state exactly one %s (found %d)" % (key, len(values[key]))
            )

    endpoint = values[_KEY_ENDPOINT][0]
    model = values[_KEY_MODEL][0]
    credential = values[_KEY_CREDENTIAL][0]

    if not endpoint.startswith("https://"):
        raise SolverConfigError("endpoint must be an https:// URL")
    if not model:
        raise SolverConfigError("model must not be empty")
    if len(credential) < 16:
        raise SolverConfigError("credential is too short to be usable")

    return SolverConfig(endpoint=endpoint, model=model, credential=credential, source=source)


def load_config(path: Path) -> Optional[SolverConfig]:
    """Return the stored configuration, or None when nothing is configured."""
    if not path.is_file():
        return None
    return _parse(path.read_text(encoding="utf-8"), path)


def save_config(path: Path, *, endpoint: str, model: str, credential: str) -> SolverConfig:
    """Validate, then write atomically. The credential is never logged here."""
    body = "".join(
        "%s=%s\n" % (key, value)
        for key, value in (
            (_KEY_ENDPOINT, endpoint.strip()),
            (_KEY_MODEL, model.strip()),
            (_KEY_CREDENTIAL, credential.strip()),
        )
    )

    # Validate before touching the filesystem, so a bad submission cannot leave a
    # half-written or unusable configuration behind.
    config = _parse(body, path)

    path.parent.mkdir(parents=True, exist_ok=True)
    handle, tmp_name = tempfile.mkstemp(
        dir=str(path.parent), prefix=".user_client.", suffix=".tmp"
    )
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(body)
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise

    try:
        os.chmod(path, 0o600)
    except OSError:
        pass  # best effort where POSIX modes are unavailable

    return config


def clear_config(path: Path) -> bool:
    """Remove the stored configuration. True when a file was actually removed."""
    try:
        path.unlink()
    except FileNotFoundError:
        return False
    return True


def public_view(config: Optional[SolverConfig], path: Path) -> Mapping[str, Any]:
    """The only shape ever returned to a caller. A credential value never appears."""
    if config is None:
        return {
            "configured": False,
            "endpoint": None,
            "model": None,
            "credential_fingerprint": None,
            "source": str(path),
        }
    return {
        "configured": True,
        "endpoint": config.endpoint,
        "model": config.model,
        "credential_fingerprint": config.fingerprint(),
        "source": str(config.source),
    }
