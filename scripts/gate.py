"""Local gate: type-check the plugin against tern.d.luau, then run the unit tests.

Tools come from $LUAU_TOOLS (default D:/tools/luau): luau.exe and luau-lsp.exe.
tern.d.luau is generated with `tern plugin types .` when missing.
"""
import os
import pathlib
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
TOOLS = pathlib.Path(os.environ.get("LUAU_TOOLS", "D:/tools/luau"))
EXE = ".exe" if os.name == "nt" else ""


def tool(name: str) -> str:
    path = TOOLS / f"{name}{EXE}"
    if path.exists():
        return str(path)
    found = shutil.which(name)
    if found:
        return found
    sys.exit(f"gate: {name} not found in {TOOLS} or PATH")


def run(argv: list[str]) -> int:
    print("$", " ".join(argv), flush=True)
    return subprocess.run(argv, cwd=ROOT).returncode


def main() -> int:
    if not (ROOT / "tern.d.luau").exists():
        if run(["tern", "plugin", "types", "."]) != 0:
            return 1
    sources = sorted(
        str(p.relative_to(ROOT)).replace("\\", "/")
        for p in ROOT.rglob("*.luau")
        if p.name != "tern.d.luau" and "tests" not in p.relative_to(ROOT).parts
    )
    failed = False
    if sources:
        failed |= run([tool("luau-lsp"), "analyze", "--definitions=tern.d.luau", *sources]) != 0
    if (ROOT / "tests" / "run.luau").exists():
        failed |= run([tool("luau"), "tests/run.luau"]) != 0
    print("gate:", "FAILED" if failed else "OK")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
