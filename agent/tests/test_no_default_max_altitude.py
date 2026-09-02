"""Guard: no default value for MAX_ALT_SAFE may exist anywhere in this repository.

Acceptance criterion 5 of DV-020, still enforced.

MAX_ALT_SAFE is the altitude at which the rear of the camera train loses clearance
against the fork base. It is measured from the assembled optical train during mount
qualification (test Q7). A default value is not a convenience — it is a number that
looks measured, and a mount that trusts it drives the camera into the fork.

Earlier planning material printed 72 degrees in a table cell marked "provisional".
This test exists so that value, or any other, cannot quietly become real.

What counts as a default, and what does not
-------------------------------------------
Forbidden, because the value appears without anyone choosing it at the call site:

    MAX_ALT_SAFE = 72                              module constant
    def build(max_altitude_degrees=72)             parameter default
    max_altitude_degrees: float = 72               annotated assignment
    {"maxAltitudeDegrees": 72}                     literal data, including seeds

Permitted, because the caller states the value explicitly every time:

    build_config(max_altitude_degrees=70.0)        keyword argument at a call site

Python is checked with the AST so those two cases can actually be told apart. A
regex cannot distinguish them, and excluding tests instead would be worse: a
fixture default is precisely how an unmeasured value ends up looking measured.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]

FIELD_NAMES = {"max_altitude_degrees", "maxAltitudeDegrees", "MAX_ALT_SAFE"}

NON_PYTHON_SUFFIXES = {".ts", ".tsx", ".mjs", ".json", ".yaml", ".yml", ".sql", ".prisma"}

SKIPPED_DIRECTORIES = {".git", ".next", ".venv", "node_modules", "__pycache__"}

# For non-Python files any numeric literal bound to the field is a default:
# those languages have no call-site keyword syntax to distinguish.
NON_PYTHON_PATTERN = re.compile(
    r"['\"]?(?:maxAltitudeDegrees|max_altitude_degrees|MAX_ALT_SAFE)['\"]?\s*[:=]\s*[-+]?\d"
)


def _is_numeric_literal(node: ast.AST | None) -> bool:
    if isinstance(node, ast.Constant):
        return isinstance(node.value, int | float) and not isinstance(node.value, bool)
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub | ast.UAdd):
        return _is_numeric_literal(node.operand)
    return False


def _target_names(node: ast.AST) -> list[str]:
    if isinstance(node, ast.Name):
        return [node.id]
    if isinstance(node, ast.Attribute):
        return [node.attr]
    return []


def tree_offences(tree: ast.AST) -> list[tuple[int, str]]:
    """Every definition-site default in this tree, as (line, description).

    One implementation, used both by the repository scan and by the guard's own
    self-test. Two copies of this logic could drift, and the copy the self-test
    exercised would be the one that was not protecting anything.
    """
    found: list[tuple[int, str]] = []

    for node in ast.walk(tree):
        # MAX_ALT_SAFE = 72   /   self.max_altitude_degrees = 72
        if isinstance(node, ast.Assign) and _is_numeric_literal(node.value):
            for target in node.targets:
                if set(_target_names(target)) & FIELD_NAMES:
                    found.append((node.lineno, "assignment of a literal"))

        # max_altitude_degrees: float = 72
        elif isinstance(node, ast.AnnAssign) and _is_numeric_literal(node.value):
            if set(_target_names(node.target)) & FIELD_NAMES:
                found.append((node.lineno, "annotated assignment of a literal"))

        # def build(max_altitude_degrees=72), including keyword-only parameters
        elif isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
            for argument, default in _parameter_defaults(node.args):
                if argument.arg in FIELD_NAMES and _is_numeric_literal(default):
                    found.append((node.lineno, f"parameter default in {node.name}()"))

        # {"maxAltitudeDegrees": 72}
        elif isinstance(node, ast.Dict):
            for key, value in zip(node.keys, node.values, strict=True):
                if (
                    isinstance(key, ast.Constant)
                    and key.value in FIELD_NAMES
                    and _is_numeric_literal(value)
                ):
                    found.append((key.lineno, "literal in a dict"))

    return found


def _parameter_defaults(arguments: ast.arguments):
    """Pair each parameter that has a default with that default."""
    positional = arguments.posonlyargs + arguments.args
    with_defaults = positional[len(positional) - len(arguments.defaults) :]
    paired = list(zip(with_defaults, arguments.defaults, strict=True))
    paired += [
        (argument, default)
        for argument, default in zip(
            arguments.kwonlyargs, arguments.kw_defaults, strict=True
        )
        if default is not None
    ]
    return paired


def python_offences(path: Path) -> list[str]:
    """Definition-site defaults only. Call-site keyword arguments are not defaults."""
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"))
    except (SyntaxError, UnicodeDecodeError, OSError):
        return []

    relative = path.relative_to(REPOSITORY_ROOT)
    return [f"{relative}:{line}: {description}" for line, description in tree_offences(tree)]


def non_python_offences(path: Path) -> list[str]:
    try:
        contents = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return []

    relative = path.relative_to(REPOSITORY_ROOT)
    return [
        f"{relative}:{number}: {line.strip()}"
        for number, line in enumerate(contents.splitlines(), start=1)
        if NON_PYTHON_PATTERN.search(line)
    ]


def searched_files() -> list[Path]:
    found: list[Path] = []
    for path in REPOSITORY_ROOT.rglob("*"):
        if not path.is_file():
            continue
        if path.suffix != ".py" and path.suffix not in NON_PYTHON_SUFFIXES:
            continue
        if SKIPPED_DIRECTORIES & set(path.parts):
            continue
        if path == Path(__file__):
            continue
        found.append(path)
    return found


def test_the_guard_actually_scans_something():
    """A guard that searches nothing passes for the wrong reason."""
    files = searched_files()
    assert len(files) > 50, f"expected to scan the repository, only found {len(files)} files"
    assert any(path.suffix == ".py" for path in files)
    assert any(path.name == "openapi.yaml" for path in files)


def test_the_guard_detects_every_forbidden_form(tmp_path):
    forbidden = [
        "MAX_ALT_SAFE = 72",
        "max_altitude_degrees: float = 72.0",
        "def build(max_altitude_degrees=68): pass",
        "def build(*, max_altitude_degrees=68): pass",
        'CONFIG = {"maxAltitudeDegrees": 72}',
        "self.max_altitude_degrees = -72",
    ]
    for index, source in enumerate(forbidden):
        candidate = tmp_path / f"case_{index}.py"
        candidate.write_text(source, encoding="utf-8")
        parsed = ast.parse(candidate.read_text(encoding="utf-8"))
        assert tree_offences(parsed), f"guard missed a default: {source!r}"


def test_the_guard_permits_an_explicit_call_site_value(tmp_path):
    """Stating the value at every call site is the discipline, not the failure."""
    candidate = tmp_path / "call_site.py"
    candidate.write_text("build_config(max_altitude_degrees=70.0)", encoding="utf-8")
    assert tree_offences(ast.parse(candidate.read_text(encoding="utf-8"))) == []


def test_no_default_max_altitude_anywhere_in_the_repository():
    offences: list[str] = []
    for path in searched_files():
        if path.suffix == ".py":
            offences.extend(python_offences(path))
        else:
            offences.extend(non_python_offences(path))

    assert not offences, (
        "A default value for MAX_ALT_SAFE was introduced. It is measured from the "
        "physical optical train, never defaulted:\n  " + "\n  ".join(offences)
    )


def test_the_contract_declares_no_default_for_max_altitude():
    """The schema itself must carry no `default:` key for this field."""
    specification = (REPOSITORY_ROOT / "contracts" / "openapi.yaml").read_text(encoding="utf-8")
    lines = specification.splitlines()

    start = next(
        index for index, line in enumerate(lines) if line.strip() == "maxAltitudeDegrees:"
    )
    indent = len(lines[start]) - len(lines[start].lstrip())

    for line in lines[start + 1 :]:
        if line.strip() and (len(line) - len(line.lstrip())) <= indent:
            break
        assert not line.strip().startswith("default:"), (
            "contracts/openapi.yaml gives maxAltitudeDegrees a default. "
            "It is nullable on purpose: null means UNMEASURED."
        )
