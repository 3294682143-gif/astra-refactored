"""Controller-owned scope selection for existing exact task grammars only.

This is not domain subtyping: unknown natural-language scopes remain unknown.
Explicit conditions/quantifiers are retained and existing domains are not widened.
"""

from dataclasses import replace

from .domain import Scope


def scope_for_goal(goal, scope=None):
    from .check_templates import enumerate_templates
    from .tool_mapping import odd_part_goal
    from .verification import arithmetic_goal, root_equation

    scope = scope or Scope()
    if scope.domain != "unspecified":
        return scope
    if arithmetic_goal(goal) is not None:
        domain = "rational"
    elif root_equation(goal) is not None:
        domain = "real"
    elif odd_part_goal(goal) is not None:
        domain = "positive_integer"
    else:
        templates = enumerate_templates(goal)
        if len(templates) != 1:
            return scope
        domain = templates[0].domain
    return replace(scope, domain=domain)
