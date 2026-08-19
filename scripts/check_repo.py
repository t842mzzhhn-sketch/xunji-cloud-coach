#!/usr/bin/env python3
"""Validate the public repository shape without network access."""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILLS = {
    "xunji-training-planner": (None, False),
    "xunji-cloud-coach": (None, False),
    "xunji-training-data": ("api.md", True),
    "xunji-food-data": ("api.md", True),
    "xunji-body-data": ("api.md", True),
}
REQUIRED_ROOT_FILES = (
    "README.md",
    "LICENSE",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "wrangler.example.jsonc",
    "migrations/0001_cloud_state.sql",
    "migrations/0002_plan_mirrors.sql",
    "content/manifest.json",
)
SECRET_PATTERNS = (
    re.compile(r"xj(?:train|food|body)_[A-Za-z0-9]{16,}"),
    re.compile(r"Authorization:\s*Bearer\s+(?!<)[A-Za-z0-9_-]{24,}", re.IGNORECASE),
    re.compile(r'"id"\s*:\s*"[0-9a-f]{32}"'),
)
APP_FIRST_REQUIREMENTS = {
    "README.md": ("Try in chat", "一个自定义 App", "不先写一份无法保存的计划"),
    "docs/chatgpt-schedules.md": ("一个 App，三个工作流", "能力门槛", "不需要 `@` Skill"),
    "skills/xunji-training-planner/SKILL.md": ("Try in chat", "FORBIDDEN: This conversation does not support developer MCPs", "不要先生成计划"),
    "skills/xunji-cloud-coach/SKILL.md": ("Try in chat", "FORBIDDEN: This conversation does not support developer MCPs", "不要先生成调整"),
}
HANDOFF_REQUIREMENTS = {
    "content/workflows/training-planner.md": ("不要结束回复", "weekly_adjustment", "新的明确确认"),
    "content/workflows/cloud-coach-weekly.md": ("首周启动", "start_date", "总纲保存确认不授权写入训练日"),
    "skills/xunji-training-planner/SKILL.md": ("同一会话完成首周只读交接", "不得把总纲保存确认复用于训记写入"),
}
MIRROR_CONSENT_REQUIREMENTS = {
    "README.md": ("总纲保存确认不自动授权", "google_docs_not_authorized", "派生摘要"),
    "content/workflows/training-planner.md": ("只确认保存总纲不等于授权镜像", "google_docs_not_authorized", "不得推迟此交接"),
    "skills/xunji-training-planner/SKILL.md": ("只确认总纲不等于授权镜像", "google_docs_not_authorized", "等待 Google Docs 授权也不得推迟交接"),
    "docs/chatgpt-schedules.md": ("只确认总纲不等于授权镜像", "google_docs_not_authorized"),
}


def public_files() -> list[Path]:
    try:
        result = subprocess.run(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        names = [line for line in result.stdout.splitlines() if line]
        if names:
            return [ROOT / name for name in names if (ROOT / name).is_file()]
    except (OSError, subprocess.CalledProcessError):
        pass

    excluded_parts = {".git", ".omx", ".wrangler", "node_modules", "__pycache__"}
    excluded_names = {"wrangler.jsonc", ".dev.vars"}
    return [
        path
        for path in ROOT.rglob("*")
        if path.is_file()
        and not excluded_parts.intersection(path.relative_to(ROOT).parts)
        and path.name not in excluded_names
    ]


def check_skill(skill_name: str, reference_name: str | None, needs_script: bool, errors: list[str]) -> None:
    directory = ROOT / "skills" / skill_name
    skill_file = directory / "SKILL.md"
    agent_file = directory / "agents" / "openai.yaml"
    required = [skill_file, agent_file]
    if reference_name is not None:
        required.append(directory / "references" / reference_name)
    if needs_script:
        required.append(directory / "scripts" / "api.py")
    for path in required:
        if not path.is_file():
            errors.append(f"missing {path.relative_to(ROOT)}")

    if not skill_file.is_file():
        return
    text = skill_file.read_text(encoding="utf-8")
    match = re.match(r"^---\n(.*?)\n---\n", text, re.DOTALL)
    if not match:
        errors.append(f"{skill_name}: invalid YAML frontmatter boundary")
        return
    frontmatter = match.group(1)
    keys = {line.split(":", 1)[0].strip() for line in frontmatter.splitlines() if ":" in line}
    if keys != {"name", "description"}:
        errors.append(f"{skill_name}: frontmatter must contain only name and description")
    if f"name: {skill_name}" not in frontmatter:
        errors.append(f"{skill_name}: frontmatter name mismatch")

    if agent_file.is_file():
        agent_text = agent_file.read_text(encoding="utf-8")
        if f"${skill_name}" not in agent_text:
            errors.append(f"{skill_name}: agents/openai.yaml default prompt must mention ${skill_name}")


def main() -> int:
    errors: list[str] = []
    for name in REQUIRED_ROOT_FILES:
        if not (ROOT / name).is_file():
            errors.append(f"missing {name}")
    for skill, (reference_name, needs_script) in SKILLS.items():
        check_skill(skill, reference_name, needs_script, errors)

    for name, required_phrases in APP_FIRST_REQUIREMENTS.items():
        path = ROOT / name
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8")
        for phrase in required_phrases:
            if phrase not in text:
                errors.append(f"{name}: missing app-first guardrail {phrase!r}")

    for name, required_phrases in HANDOFF_REQUIREMENTS.items():
        path = ROOT / name
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8")
        for phrase in required_phrases:
            if phrase not in text:
                errors.append(f"{name}: missing first-week handoff rule {phrase!r}")

    for name, required_phrases in MIRROR_CONSENT_REQUIREMENTS.items():
        path = ROOT / name
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8")
        for phrase in required_phrases:
            if phrase not in text:
                errors.append(f"{name}: missing Google Docs consent guardrail {phrase!r}")

    for path in public_files():
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for pattern in SECRET_PATTERNS:
            if pattern.search(text):
                errors.append(f"potential secret or personal resource id in {path.relative_to(ROOT)}")
                break

    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print(f"validated {len(SKILLS)} skills and public repository safety checks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
