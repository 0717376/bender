"""Библиотека книг: разбор epub, чистка исполняемого, папка на книгу, корзина."""

import io
import json
import os
import sys
import zipfile

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

COVER = b"\x89PNG\r\n\x1a\n" + b"0" * 40


def make_epub(title="Проверка чтения", author="Тестовый Автор", *, script=False,
              cover=True, chapters=2, broken=False):
    """Минимальный валидный epub. script=True — со скриптом и обработчиком, как в чужой книге."""
    if broken:
        return b"not a zip at all"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("mimetype", "application/epub+zip", zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml",
                   '<?xml version="1.0"?><container version="1.0" '
                   'xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles>'
                   '<rootfile full-path="OEBPS/content.opf" '
                   'media-type="application/oebps-package+xml"/></rootfiles></container>')
        items, refs = [], []
        for i in range(1, chapters + 1):
            items.append(f'<item id="c{i}" href="c{i}.xhtml" media-type="application/xhtml+xml"/>')
            refs.append(f'<itemref idref="c{i}"/>')
            body = f"<p>Глава {i}. Текст, который потом читает агент.</p>"
            if script:
                body += ('<script>fetch("/auth/me")</script>'
                         '<p onclick="alert(1)">кнопка</p>'
                         '<a href="javascript:alert(2)">ссылка</a>')
            z.writestr(f"OEBPS/c{i}.xhtml",
                       '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml">'
                       f"<head><title>Глава {i}</title></head><body>{body}</body></html>")
        if script:
            z.writestr("OEBPS/js/track.js", "navigator.sendBeacon('/x')")
            items.append('<item id="js" href="js/track.js" media-type="text/javascript"/>')
        if cover:
            z.writestr("OEBPS/cover.png", COVER)
            items.append('<item id="cv" href="cover.png" media-type="image/png" properties="cover-image"/>')
        z.writestr("OEBPS/content.opf",
                   '<?xml version="1.0" encoding="utf-8"?>'
                   '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bid">'
                   '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
                   f"<dc:identifier id=\"bid\">urn:test</dc:identifier><dc:title>{title}</dc:title>"
                   f"<dc:creator>{author}</dc:creator><dc:language>ru</dc:language></metadata>"
                   f"<manifest>{''.join(items)}</manifest><spine>{''.join(refs)}</spine></package>")
    return buf.getvalue()


@pytest.fixture
def books(tmp_path, monkeypatch):
    from app import books_api, config

    monkeypatch.setattr(config, "BOOKS_DIR", str(tmp_path))
    books_api.init()
    return books_api


# ── Разбор ──


def test_читает_название_автора_и_главы(books):
    meta = books.ingest(make_epub(), "book.epub")
    assert meta["title"] == "Проверка чтения"
    assert meta["author"] == "Тестовый Автор"
    assert meta["chapters"] == 2
    assert meta["cover"] == "cover.png"


def test_не_epub_отвергается(books):
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as e:
        books.ingest(make_epub(broken=True), "wat.epub")
    assert e.value.status_code == 400


def test_имя_файла_вместо_пустого_названия(books):
    meta = books.ingest(make_epub(title=""), "Мой конспект.epub")
    assert meta["title"] == "Мой конспект"


# ── Чистка ──


def test_из_книги_вырезаются_скрипты_и_обработчики(books):
    meta = books.ingest(make_epub(script=True), "shady.epub")
    with zipfile.ZipFile(os.path.join(str(books.config.BOOKS_DIR), meta["id"], "book.epub")) as z:
        assert not [n for n in z.namelist() if n.endswith(".js")]
        page = z.read("OEBPS/c1.xhtml")
    assert b"<script" not in page.lower()
    assert b"onclick" not in page.lower()
    assert b"javascript:" not in page.lower()
    assert b"<p>" in page          # сама книга осталась читаемой


def test_чистая_книга_остаётся_валидным_zip(books):
    meta = books.ingest(make_epub(script=True), "shady.epub")
    path = os.path.join(str(books.config.BOOKS_DIR), meta["id"], "book.epub")
    with zipfile.ZipFile(path) as z:
        assert z.testzip() is None
        assert z.read("mimetype") == b"application/epub+zip"
        assert z.getinfo("mimetype").compress_type == zipfile.ZIP_STORED


# ── Библиотека ──


def test_книга_ложится_папкой_с_текстом_глав(books):
    meta = books.ingest(make_epub(), "book.epub")
    root = os.path.join(str(books.config.BOOKS_DIR), meta["id"])
    assert os.path.isfile(os.path.join(root, "book.epub"))
    assert os.path.isfile(os.path.join(root, "meta.json"))
    assert os.path.isfile(os.path.join(root, "cover.png"))
    text = open(os.path.join(root, "text", "001.txt"), encoding="utf-8").read()
    assert "<p>" not in text
    # Заголовок из <head> в текст главы не попадает — иначе агент читает его дважды.
    assert text.count("Глава 1") == 1


def test_та_же_книга_не_двоится(books):
    data = make_epub()
    first = books.ingest(data, "book.epub")
    again = books.ingest(data, "копия.epub")
    assert again["id"] == first["id"]
    assert again.get("known") is True
    assert len(books.catalog()) == 1


def test_разные_книги_получают_разные_id(books):
    a = books.ingest(make_epub(title="Первая"), "a.epub")
    b = books.ingest(make_epub(title="Вторая"), "b.epub")
    assert a["id"] != b["id"]
    assert {m["title"] for m in books.catalog()} == {"Первая", "Вторая"}


def test_каталог_новыми_вперёд(books):
    old = books.ingest(make_epub(title="Старая"), "a.epub")
    meta_path = os.path.join(str(books.config.BOOKS_DIR), old["id"], "meta.json")
    meta = json.load(open(meta_path, encoding="utf-8"))
    meta["added"] -= 1000
    json.dump(meta, open(meta_path, "w", encoding="utf-8"), ensure_ascii=False)
    books.ingest(make_epub(title="Новая"), "b.epub")
    assert [m["title"] for m in books.catalog()] == ["Новая", "Старая"]


def test_удаление_уносит_в_корзину(books):
    meta = books.ingest(make_epub(), "book.epub")
    books.remove(meta["id"])
    assert books.catalog() == []
    trash = os.path.join(str(books.config.BOOKS_DIR), ".trash")
    assert any(meta["id"] in name for name in os.listdir(trash))


def test_корзина_не_видна_в_каталоге(books):
    books.ingest(make_epub(), "book.epub")
    os.makedirs(os.path.join(str(books.config.BOOKS_DIR), ".hidden"), exist_ok=True)
    assert len(books.catalog()) == 1


def test_id_с_прогулкой_по_путям_не_проходит(books):
    from fastapi import HTTPException

    for bad in ("../etc", "a/b", "", "с пробелом"):
        with pytest.raises(HTTPException):
            books.book_dir(bad)


# ── Переезд первой версии ──


def test_книга_лежавшая_файлом_переезжает_в_папку(books):
    root = str(books.config.BOOKS_DIR)
    with open(os.path.join(root, "aposd.epub"), "wb") as f:
        f.write(make_epub(title="Прежняя"))
    books.init()
    assert not os.path.exists(os.path.join(root, "aposd.epub"))
    # id сохраняем из имени файла: к нему привязаны прогресс и выписки прежней версии.
    assert [m["id"] for m in books.catalog()] == ["aposd"]
    assert os.path.isfile(os.path.join(root, "aposd", "book.epub"))


def test_битый_файл_при_переезде_не_ломает_запуск(books):
    root = str(books.config.BOOKS_DIR)
    with open(os.path.join(root, "broken.epub"), "wb") as f:
        f.write(b"not an epub")
    books.init()
    assert books.catalog() == []
    assert os.path.exists(os.path.join(root, "broken.epub"))   # оставили как есть, не выбросили
