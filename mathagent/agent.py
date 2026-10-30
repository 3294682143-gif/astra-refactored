"""CLI entry point for mathagent standalone invocation.

Supports:
    python -m mathagent.agent "1+1=?"
"""
from __future__ import annotations

import os
import sys

from mathagent.atria_client import AtriaDawnClient


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python -m mathagent.agent '<problem>'")
        sys.exit(1)

    problem = sys.argv[1].strip()
    if not problem:
        print("Empty problem provided")
        sys.exit(1)

    atria_key = (
        os.environ.get("ASTRA_ATRIA_API_KEY")
        or os.environ.get("ATRIA_API_KEY")
        or os.environ.get("INTERNS1_API_KEY")
        or os.environ.get("INTERN_API_KEY")
    )
    endpoint = os.environ.get(
        "ASTRA_ATRIA_ENDPOINT",
        "https://discovery-api.intern-ai.org.cn/v1/chat/completions",
    ).strip()
    model = os.environ.get("ASTRA_ATRIA_MODEL", "Atria-Dawn").strip()
    reasoning_mode = os.environ.get("ASTRA_ATRIA_REASONING_MODE", "hybrid").strip()

    if not atria_key:
        print("SOLVER_NOT_CONFIGURED: Missing API key in environment")
        sys.exit(1)

    client = AtriaDawnClient(
        api_key=atria_key,
        endpoint=endpoint,
        model=model,
        reasoning_mode=reasoning_mode,
    )
    result = client.chat(
        messages=[
            {"role": "system", "content": "你是一个精确的数学与推理助手，请直接给出准确的回答。"},
            {"role": "user", "content": problem},
        ],
        temperature=0.2,
        max_tokens=256,
        thinking_mode=False,
        stream=True,
        timeout=30.0,
        cancellation=None,
    )

    content = result["choices"][0]["message"]["content"]
    print(content)


if __name__ == "__main__":
    main()
