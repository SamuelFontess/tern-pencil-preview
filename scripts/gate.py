"""Local gate: type-check the plugin against tern.d.luau, check that window.luau preloads every module the editor
requires, run the Luau unit tests, then the Node unit tests and the build check. `--engine` also runs the real-engine
integration tests (editor/integration/*.test.mjs): slower, and needs TERN_PENCIL_CLI or a pen CLI on PATH.

Tools come from $LUAU_TOOLS (default D:/tools/luau): luau.exe, luau-lsp.exe and luau-ast.exe (the preload check reads
the AST of window.luau and of every module the editor requires). tern.d.luau is generated with `tern plugin types .`
when missing. Node >=22 and npm are required for the Node steps.
"""
import argparse
import json
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


def npm_argv() -> list[str]:
    node = shutil.which("node")
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    if not node or not npm:
        sys.exit("gate: Node >=22 and npm are required")
    launcher = pathlib.Path(npm)
    entry = (launcher.parent / "node_modules/npm/bin/npm-cli.js"
             if os.name == "nt" else launcher.resolve())
    if not entry.is_file():
        sys.exit(f"gate: npm CLI entry not found: {entry}")
    return [node, str(entry)]


def run(argv: list[str]) -> int:
    print("$", " ".join(argv), flush=True)
    return subprocess.run(argv, cwd=ROOT).returncode


class AstError(Exception):
    pass


def scan_requires(node, rel: str, found: list[str], problems: list[str]) -> None:
    """Collects the constant paths of every `require("...")` call under an AST node, in source order. Any other use of
    the global `require` (a computed path, `(require :: any)(...)`, `pcall(require, ...)`) cannot be followed and is a
    problem. `typeof(...)` in a type position never runs, so it is skipped."""
    if isinstance(node, dict):
        if node.get("type") == "AstTypeTypeof":
            return
        if node.get("type") == "AstExprGlobal" and node.get("global") == "require":
            problems.append(f"{rel}: `require` used other than as require(\"constant path\") cannot be checked")
            return
        if node.get("type") == "AstExprCall" and node["func"].get("global") == "require":
            args = node["args"]
            if len(args) == 1 and args[0].get("type") == "AstExprConstantString":
                found.append(args[0]["value"])
            else:
                problems.append(f"{rel}: a require whose path is not one constant string cannot be checked")
                scan_requires(args, rel, found, problems)
            return
        for value in node.values():
            scan_requires(value, rel, found, problems)
    elif isinstance(node, list):
        for value in node:
            scan_requires(value, rel, found, problems)


def ast_root(root: pathlib.Path, rel: str) -> dict:
    try:
        done = subprocess.run([tool("luau-ast"), str(root / f"{rel}.luau")], capture_output=True, encoding="utf-8", errors="replace")
        if done.returncode != 0:
            raise AstError(f"luau-ast failed on {rel}.luau: {done.stderr.strip() or done.stdout.strip()}"[:300])
        return json.loads(done.stdout)["root"]
    except (OSError, ValueError, KeyError) as error:
        raise AstError(f"luau-ast failed on {rel}.luau: {error}") from error


def module_path(rel: str, required: str) -> str:
    """`required` as written in the module `rel`, as a path under the plugin root without extension."""
    return os.path.normpath(os.path.join(os.path.dirname(rel), required)).replace("\\", "/")


def check_preload(root: pathlib.Path) -> list[str]:
    """Every module the editor requires must be preloaded by window.luau (EDITOR_LOADERS), one per tick, after the
    modules it requires itself: a `require` left cold inside a tick that does work is what blew the 50 ms budget."""
    problems: list[str] = []
    try:
        body = ast_root(root, "window")["body"]
        lists = [s for s in body if s.get("type") == "AstStatLocal" and s["vars"][0]["name"] == "EDITOR_LOADERS"]
        if len(lists) != 1:
            return ["window.luau: EDITOR_LOADERS not found"]
        found: list[str] = []
        scan_requires(lists[0], "window.luau EDITOR_LOADERS", found, problems)
        loaded = [module_path("window", path) for path in found]
        needed: dict[str, list[str]] = {}
        pending = ["editor_board"]
        while pending:
            rel = pending.pop()
            if rel not in needed:
                found = []
                scan_requires(ast_root(root, rel), f"{rel}.luau", found, problems)
                needed[rel] = [module_path(rel, path) for path in found]
                pending += needed[rel]
    except AstError as error:
        return [str(error)]
    problems += [f"{rel} is required by the editor but window.luau does not preload it" for rel in sorted(needed) if rel not in loaded]
    for index, rel in enumerate(loaded):
        problems += [f"{rel} requires {dep}, which window.luau preloads after it" for dep in needed.get(rel, []) if dep in loaded and loaded.index(dep) > index]
    return problems


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine", action="store_true", help="also run the real-engine integration tests")
    args = parser.parse_args()
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
    if (ROOT / "window.luau").exists():
        problems = check_preload(ROOT)
        for problem in problems:
            print("gate: preload:", problem, flush=True)
        failed |= bool(problems)
    if (ROOT / "tests" / "run.luau").exists():
        failed |= run([tool("luau"), "tests/run.luau"]) != 0
    if (ROOT / "package.json").exists():
        npm = npm_argv()
        failed |= run([*npm, "test"]) != 0
        failed |= run([*npm, "run", "check:build"]) != 0
        if args.engine:
            failed |= run([*npm, "run", "test:engine"]) != 0
    print("gate:", "FAILED" if failed else "OK")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
