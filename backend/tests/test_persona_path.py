"""Страница персоны: историческое имя кириллицей и латинский слаг — оба рабочие."""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pytest.fixture
def wiki_dir(tmp_path, monkeypatch):
    from app import config

    monkeypatch.setattr(config, "WIKI_DIR", str(tmp_path))
    monkeypatch.delenv("PERSONA_PATH", raising=False)
    return tmp_path


def path_now():
    from app import config

    return os.path.basename(config.persona_path())


def test_prefers_slug_when_present(wiki_dir):
    (wiki_dir / "persona.md").write_text("# Персона\n", encoding="utf-8")
    (wiki_dir / "Персона ассистента.md").write_text("# Старая\n", encoding="utf-8")
    assert path_now() == "persona.md"


def test_falls_back_to_legacy_name(wiki_dir):
    """Пока страницу не переименовали, персона должна читаться со старого имени."""
    (wiki_dir / "Персона ассистента.md").write_text("# Персона\n", encoding="utf-8")
    assert path_now() == "Персона ассистента.md"


def test_follows_rename_without_restart(wiki_dir):
    """Путь ищется при каждом чтении: переименование не требует перезапуска."""
    legacy = wiki_dir / "Персона ассистента.md"
    legacy.write_text("# Персона\n", encoding="utf-8")
    assert path_now() == "Персона ассистента.md"

    legacy.rename(wiki_dir / "persona.md")
    assert path_now() == "persona.md"


def test_seeds_under_slug_when_nothing_exists(wiki_dir):
    assert path_now() == "persona.md"


def test_env_override_wins(wiki_dir, monkeypatch):
    monkeypatch.setenv("PERSONA_PATH", "/custom/soul.md")
    from app import config

    assert config.persona_path() == "/custom/soul.md"
