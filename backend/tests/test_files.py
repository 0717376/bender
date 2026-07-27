"""Иерархия страниц вики: имена файлов, продвижение в родителя, ссылки, корзина."""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class Wiki:
    """Вики на диске: обращения проксируются в files.py, плюс write/read для фикстур."""

    def __init__(self, root, module):
        self.root = root
        self._module = module

    def __getattr__(self, name):
        return getattr(self._module, name)

    def write(self, rel: str, text: str = "# страница\n") -> str:
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return rel

    def read(self, rel: str) -> str:
        return (self.root / rel).read_text(encoding="utf-8")


@pytest.fixture
def wiki(tmp_path, monkeypatch):
    from app import config, files

    monkeypatch.setattr(config, "WIKI_DIR", str(tmp_path))
    return Wiki(tmp_path, files)


# ── Имена файлов ──

@pytest.mark.parametrize(("raw", "want"), [
    ("Гига-VPN", "giga-vpn"),
    ("Персона ассистента", "persona-assistenta"),
    ("home-network", "home-network"),
    ("Что где живёт?", "chto-gde-zhivet"),
    ("  Ёлки   и  Палки  ", "elki-i-palki"),
    ("Résumé", "resume"),
    ("", "page"),
    ("???", "page"),
])
def test_slugify(wiki, raw, want):
    assert wiki.slugify(raw) == want


def test_slugify_idempotent(wiki):
    once = wiki.slugify("Гига-VPN 2.0")
    assert wiki.slugify(once) == once


def test_slug_path_keeps_existing_file(wiki):
    """Иначе запись в кириллическую страницу плодила бы её латинского двойника."""
    wiki.write("Персона ассистента.md")
    assert wiki.slug_path("Персона ассистента.md") == "Персона ассистента.md"


def test_slug_path_normalizes_new_page(wiki):
    assert wiki.slug_path("Инфра/Машины/Гига-VPN.md") == "infra/mashiny/giga-vpn.md"


def test_slug_path_keeps_reserved_names(wiki):
    """CLAUDE.md — имя по договорённости: claude.md агент читать не станет."""
    assert wiki.slug_path("CLAUDE.md") == "CLAUDE.md"
    assert wiki.slug_path("Инфра/CLAUDE.md") == "infra/CLAUDE.md"


def test_rel_path_survives_symlinked_root(tmp_path, monkeypatch):
    """Корень вики бывает симлинком (/tmp → /private/tmp) — иначе путь уезжает в «../..»."""
    from app import config, files

    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real)
    monkeypatch.setattr(config, "WIKI_DIR", str(link))

    assert files.rel_path(str(link / "infra" / "hermes.md")) == "infra/hermes.md"


# ── Дерево ──

def test_tree_collapses_index(wiki):
    wiki.write("infra/index.md", "# Инфраструктура\n")
    wiki.write("infra/hermes.md", "# Hermes\n")
    tree = wiki.build_tree(wiki.config.WIKI_DIR, "")

    (node,) = tree
    assert node["path"] == "infra"
    assert node["page"] == "infra/index.md"
    assert node["title"] == "Инфраструктура"
    assert [c["path"] for c in node["children"]] == ["infra/hermes.md"]


def test_tree_keeps_plain_folder_without_index(wiki):
    wiki.write("misc/note.md")
    (node,) = wiki.build_tree(wiki.config.WIKI_DIR, "")
    assert "page" not in node


def test_tree_keeps_root_index(wiki):
    """index.md в корне вики — обычная страница, схлопывать её не с чем."""
    wiki.write("index.md", "# Главная\n")
    assert [n["path"] for n in wiki.build_tree(wiki.config.WIKI_DIR, "")] == ["index.md"]


# ── Ссылки ──

def test_move_fixes_inbound_links(wiki):
    wiki.write("infra/index.md", "# Инфра\nСмотри [Timeweb](machines/timeweb.md).\n")
    wiki.write("infra/machines/timeweb.md", "# Timeweb\n")

    wiki.move("infra/machines/timeweb.md", "infra/cloud/timeweb.md")

    assert "[Timeweb](cloud/timeweb.md)" in wiki.read("infra/index.md")


def test_move_fixes_links_inside_moved_page(wiki):
    """У переехавшей страницы сменилась папка — её собственные ссылки тоже врут."""
    wiki.write("infra/machines/timeweb.md", "# Timeweb\nСеть: [дом](../home-network.md)\n")
    wiki.write("infra/home-network.md", "# Дом\n")

    wiki.move("infra/machines/timeweb.md", "timeweb.md")

    assert "[дом](infra/home-network.md)" in wiki.read("timeweb.md")


def test_move_keeps_anchor_and_external_links(wiki):
    wiki.write("a.md", "# A\n[раздел](b.md#доступ) и [сайт](https://example.com/b.md)\n")
    wiki.write("b.md", "# B\n")

    wiki.move("b.md", "sub/b.md")

    text = wiki.read("a.md")
    assert "[раздел](sub/b.md#доступ)" in text
    assert "[сайт](https://example.com/b.md)" in text


def test_move_folder_fixes_links_to_children(wiki):
    wiki.write("index.md", "# Главная\n[LiteLLM](infra/litellm.md)\n")
    wiki.write("infra/litellm.md", "# LiteLLM\n")

    wiki.move("infra", "cloud")

    assert "[LiteLLM](cloud/litellm.md)" in wiki.read("index.md")


# ── Родительские страницы ──

def test_promote_makes_parent_and_fixes_links(wiki):
    wiki.write("index.md", "# Главная\n[Timeweb](machines/timeweb.md)\n")
    wiki.write("machines/timeweb.md", "# Timeweb\n")

    assert wiki.promote("machines/timeweb.md") == "machines/timeweb/index.md"
    assert "[Timeweb](machines/timeweb/index.md)" in wiki.read("index.md")


def test_ensure_page_gives_folder_its_own_page(wiki):
    """Папок в модели вики нет: у всякой папки есть своя страница."""
    (wiki.root / "notes").mkdir()

    assert wiki.ensure_page("notes") == "notes/index.md"
    # Пустая, а не «# notes»: слаг папки — идентификатор, выдавать его за
    # заголовок значит заставить человека сначала стереть выдумку.
    assert wiki.read("notes/index.md") == ""
    (node,) = wiki.build_tree(wiki.config.WIKI_DIR, "")
    assert node["title"] == "notes"


def test_ensure_page_prefers_existing_sibling(wiki):
    """`timeweb.md` рядом с папкой `timeweb/` — это и есть её страница, а не пустышка."""
    wiki.write("machines/timeweb.md", "# Timeweb\nсервисы\n")
    (wiki.root / "machines" / "timeweb").mkdir()
    wiki.write("machines/timeweb/litellm.md", "# LiteLLM\n")

    assert wiki.ensure_page("machines/timeweb") == "machines/timeweb/index.md"
    assert wiki.read("machines/timeweb/index.md") == "# Timeweb\nсервисы\n"
    assert not os.path.exists(wiki.root / "machines" / "timeweb.md")


@pytest.mark.parametrize(("parent", "want"), [
    ("", ""),
    ("infra", "infra"),
    ("infra/index.md", "infra"),
    ("infra/hermes.md", "infra/hermes"),
])
def test_page_folder(wiki, parent, want):
    wiki.write("infra/index.md", "# Инфра\n")
    wiki.write("infra/hermes.md", "# Hermes\n")
    assert wiki.page_folder(parent) == want


def test_page_folder_promotes_plain_page(wiki):
    wiki.write("index.md", "# Главная\n[Hermes](infra/hermes.md)\n")
    wiki.write("infra/hermes.md", "# Hermes\n")

    wiki.page_folder("infra/hermes.md")

    assert wiki.read("infra/hermes/index.md") == "# Hermes\n"
    assert "[Hermes](infra/hermes/index.md)" in wiki.read("index.md")


def test_normalize_pages_fixes_folders_without_a_page(wiki):
    wiki.write("uchyoba/notes/lекция.md", "# Лекция\n")
    wiki.write("machines/timeweb.md", "# Timeweb\n")
    wiki.write("machines/timeweb/litellm.md", "# LiteLLM\n")

    made = wiki.normalize_pages()

    assert wiki.read("uchyoba/notes/index.md") == ""
    assert wiki.read("machines/timeweb/index.md") == "# Timeweb\n"
    assert [n.get("page") for n in wiki.build_tree(wiki.config.WIKI_DIR, "")] == [
        "machines/index.md", "uchyoba/index.md",
    ]
    # Вмешательство в чужой контент должно быть поимённым, а не «починил 3 папки».
    assert dict(made) == {
        "machines/index.md": "created",
        "machines/timeweb/index.md": "promoted",
        "uchyoba/index.md": "created",
        "uchyoba/notes/index.md": "created",
    }


@pytest.mark.parametrize(("rel", "want"), [
    ("infra/machines/index.md", "machines"),
    ("infra/hermes.md", "hermes"),
    ("index.md", "index"),
])
def test_page_label(wiki, rel, want):
    """Страницу без заголовка зовут по папке — «index» пользователь видеть не должен."""
    assert wiki.page_label(rel) == want


def test_search_titles_headless_page_by_folder(wiki):
    wiki.write("uchyoba/notes/index.md", "конспекты с лекций")

    import asyncio

    res = asyncio.run(wiki.files_search(q="конспекты", limit=10, _=True))

    assert [r["title"] for r in res["results"]] == ["notes"]


def test_ensure_parent_promotes_page_on_the_way(wiki):
    """Запись ребёнка под обычной страницей делает её родительской."""
    wiki.write("timeweb.md", "# Timeweb\n")

    wiki.ensure_parent(os.path.join(wiki.config.WIKI_DIR, "timeweb", "litellm.md"))

    assert os.path.isfile(os.path.join(wiki.config.WIKI_DIR, "timeweb", "index.md"))
    assert not os.path.exists(os.path.join(wiki.config.WIKI_DIR, "timeweb.md"))


# ── Корзина ──

def test_delete_goes_to_trash_and_can_be_restored(wiki):
    wiki.write("note.md", "# Заметка\n")

    trashed = wiki.to_trash("note.md")

    assert trashed.startswith(wiki.TRASH + "/")
    assert not os.path.exists(os.path.join(wiki.config.WIKI_DIR, "note.md"))
    wiki.move(trashed, "note.md")
    assert wiki.read("note.md") == "# Заметка\n"


def test_trash_is_invisible_to_tree_and_search(wiki):
    wiki.write("note.md", "# Заметка\nсекрет\n")
    wiki.to_trash("note.md")

    assert wiki.build_tree(wiki.config.WIKI_DIR, "") == []
    assert list(wiki.walk_pages()) == []
