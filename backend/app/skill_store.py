"""Procedural skills the agent authors from experience — now native SDK Skills.

Each skill is a real Skill on disk: data/learned/skills/<slug>/SKILL.md with native
frontmatter (name + description) + a markdown body. The whole data/learned tree is a
local plugin loaded via the `plugins` option, so the model discovers these skills through
progressive disclosure and invokes them via the Skill tool — no index injection needed.

The Curator consolidates this library during idle time; snapshots make it reversible.
"""

import os
import re
import shutil
import threading
from datetime import datetime

from . import config

_lock = threading.Lock()

# Names owned by the baked-in domain plugin — learned skills must not shadow them.
RESERVED = {"wiki", "tasks"}

# Minimal Cyrillic→Latin transliteration so Russian skill names yield meaningful ASCII
# slugs (native skill names / dir names must be ASCII kebab to invoke cleanly).
_RU = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e", "ж": "zh",
    "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o",
    "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f", "х": "h", "ц": "ts",
    "ч": "ch", "ш": "sh", "щ": "sch", "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu",
    "я": "ya",
}


def _translit(s: str) -> str:
    return "".join(_RU.get(ch, ch) for ch in s)


def _slug(name: str) -> str:
    s = _translit(name.lower())
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s[:60]


# --- Plugin layout ---

def _skills_root() -> str:
    os.makedirs(config.LEARNED_SKILLS_DIR, exist_ok=True)
    return config.LEARNED_SKILLS_DIR


def _skill_dir(slug: str) -> str:
    return os.path.join(_skills_root(), slug)


def _skill_path(slug: str) -> str:
    return os.path.join(_skill_dir(slug), "SKILL.md")


def ensure_plugin() -> None:
    """Create the learned-skills plugin scaffolding on the data volume (persists across
    image rebuilds). Idempotent."""
    meta_dir = os.path.join(config.LEARNED_PLUGIN_DIR, ".claude-plugin")
    os.makedirs(meta_dir, exist_ok=True)
    os.makedirs(config.LEARNED_SKILLS_DIR, exist_ok=True)
    manifest = os.path.join(meta_dir, "plugin.json")
    if not os.path.exists(manifest):
        with open(manifest, "w", encoding="utf-8") as f:
            f.write('{\n  "name": "learned",\n  "version": "1.0.0",\n'
                    '  "description": "Навыки, которые агент накопил из опыта (процедурная память)."\n}\n')


# --- Frontmatter ---

def _render(name: str, description: str, body: str) -> str:
    # Native skills read only name + description from frontmatter.
    return f"---\nname: {name}\ndescription: {description}\n---\n\n{body.strip()}\n"


def _parse(raw: str) -> tuple[dict, str]:
    meta: dict = {}
    body = raw
    if raw.startswith("---"):
        end = raw.find("\n---", 3)
        if end != -1:
            fm = raw[3:end].strip()
            body = raw[end + 4:].lstrip("\n")
            for line in fm.splitlines():
                if ":" in line:
                    k, v = line.split(":", 1)
                    meta[k.strip()] = v.strip()
    return meta, body


def _read_raw(slug: str) -> str | None:
    try:
        with open(_skill_path(slug), encoding="utf-8") as f:
            return f.read()
    except FileNotFoundError:
        return None


def _all_slugs() -> list[str]:
    root = _skills_root()
    return sorted(
        d for d in os.listdir(root)
        if os.path.isfile(os.path.join(root, d, "SKILL.md"))
    )


def _resolve(name_or_slug: str) -> str | None:
    slug = _slug(name_or_slug)
    if slug and os.path.exists(_skill_path(slug)):
        return slug
    for s in _all_slugs():
        meta, _ = _parse(_read_raw(s) or "")
        if meta.get("name", "").lower() == name_or_slug.lower():
            return s
    return None


# --- Public API ---

def list_skills() -> list[dict]:
    with _lock:
        out = []
        for slug in _all_slugs():
            meta, _ = _parse(_read_raw(slug) or "")
            out.append({
                "slug": slug,
                "name": meta.get("name", slug),
                "description": meta.get("description", ""),
            })
        return out


def read_skill(name_or_slug: str) -> dict | None:
    with _lock:
        slug = _resolve(name_or_slug)
        if not slug:
            return None
        meta, body = _parse(_read_raw(slug) or "")
        return {"slug": slug, "meta": meta, "body": body}


def save_skill(name: str, description: str, body: str) -> dict:
    """Create or update a learned skill as a native SKILL.md. Overwrites if the slug
    already exists (so this is both 'create' and 'edit')."""
    slug = _slug(name)
    if not slug:
        return {"error": "Дай name латиницей (kebab-case), напр. 'deploy-backend'."}
    if slug in RESERVED:
        return {"error": f"Имя '{slug}' зарезервировано за доменным навыком — выбери другое."}
    with _lock:
        os.makedirs(_skill_dir(slug), exist_ok=True)
        with open(_skill_path(slug), "w", encoding="utf-8") as f:
            f.write(_render(slug, description, body))
        return {"slug": slug, "ok": True}


def delete_skill(name_or_slug: str) -> dict:
    with _lock:
        slug = _resolve(name_or_slug)
        if not slug:
            return {"error": "не найдено"}
        shutil.rmtree(_skill_dir(slug), ignore_errors=True)
        return {"slug": slug, "ok": True}


# --- One-time migration from the old flat layout (data/skills/<slug>.md) ---

def _migrate_legacy() -> None:
    legacy = config.LEGACY_SKILLS_DIR
    if not os.path.isdir(legacy):
        return
    files = [f for f in os.listdir(legacy) if f.endswith(".md")]
    if not files:
        return
    for fname in files:
        try:
            with open(os.path.join(legacy, fname), encoding="utf-8") as f:
                meta, body = _parse(f.read())
        except OSError:
            continue
        name = meta.get("name") or fname[:-3]
        slug = _slug(name) or _slug(fname[:-3]) or f"skill-{len(_all_slugs()) + 1}"
        if os.path.exists(_skill_path(slug)):
            continue  # already migrated
        os.makedirs(_skill_dir(slug), exist_ok=True)
        with open(_skill_path(slug), "w", encoding="utf-8") as f:
            f.write(_render(slug, meta.get("description", ""), body))
    # Park the old dir so the migration never runs twice and nothing is lost.
    shutil.move(legacy, legacy + "_migrated")


def init() -> None:
    ensure_plugin()
    try:
        _migrate_legacy()
    except Exception:  # noqa: BLE001 — migration must never block startup
        import logging
        logging.getLogger("wiki.skills").exception("legacy skill migration failed")


# --- Snapshot / rollback (for the Curator) ---

def snapshot(reason: str = "curator") -> str:
    os.makedirs(config.SKILL_BACKUPS_DIR, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%dT%H%M%S")
    dest = os.path.join(config.SKILL_BACKUPS_DIR, f"{ts}-{reason}")
    shutil.copytree(_skills_root(), dest)
    snaps = sorted(os.listdir(config.SKILL_BACKUPS_DIR))
    for old in snaps[:-10]:  # keep only the 10 most recent
        shutil.rmtree(os.path.join(config.SKILL_BACKUPS_DIR, old), ignore_errors=True)
    return dest


def list_snapshots() -> list[str]:
    if not os.path.isdir(config.SKILL_BACKUPS_DIR):
        return []
    return sorted(os.listdir(config.SKILL_BACKUPS_DIR))


def rollback(snapshot_name: str) -> dict:
    src = os.path.join(config.SKILL_BACKUPS_DIR, snapshot_name)
    if not os.path.isdir(src):
        return {"error": "снапшот не найден"}
    snapshot(reason="pre-rollback")  # make the rollback itself undoable
    with _lock:
        shutil.rmtree(_skills_root(), ignore_errors=True)
        shutil.copytree(src, _skills_root())
    return {"ok": True, "restored": snapshot_name}
