"""Библиотека книг: разбор epub, чистка исполняемого, папка на книгу, корзина."""

import io
import json
import os
import sys
import zipfile

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

COVER = b"\x89PNG\r\n\x1a\n" + b"0" * 40
JPEG = b"\xff\xd8\xff" + b"0" * 200          # миниатюра: важно только начало файла


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
    from app import books_api, books_store, config

    monkeypatch.setattr(config, "BOOKS_DIR", str(tmp_path / "books"))
    monkeypatch.setattr(config, "DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(config, "WIKI_DIR", str(tmp_path / "content"))
    (tmp_path / "content").mkdir()
    books_store.init()
    books_api.init()
    books_api.store = books_store
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


# ── Миниатюра обложки ──


def test_миниатюра_кладётся_и_попадает_в_каталог(books):
    meta = books.ingest(make_epub(), "book.epub")
    assert meta["thumb"] == ""
    path = os.path.join(str(books.config.BOOKS_DIR), meta["id"], books.THUMB)
    with open(path, "wb") as f:
        f.write(JPEG)
    saved = dict(meta, thumb=books.THUMB)
    with open(os.path.join(str(books.config.BOOKS_DIR), meta["id"], "meta.json"), "w", encoding="utf-8") as f:
        json.dump(saved, f, ensure_ascii=False)
    assert books.catalog()[0]["thumb"] == books.THUMB


def test_не_jpeg_миниатюрой_не_считается(books):
    import asyncio

    from fastapi import HTTPException

    meta = books.ingest(make_epub(), "book.epub")

    class Req:
        def __init__(self, data):
            self._data = data

        async def body(self):
            return self._data

    with pytest.raises(HTTPException) as e:
        asyncio.run(books.put_thumb(meta["id"], Req(b"<html>not a picture"), True))
    assert e.value.status_code == 400

    with pytest.raises(HTTPException) as e:
        asyncio.run(books.put_thumb(meta["id"], Req(b"\xff\xd8\xff" + b"0" * (books.THUMB_MAX + 1)), True))
    assert e.value.status_code == 413

    updated = asyncio.run(books.put_thumb(meta["id"], Req(JPEG), True))
    assert updated["thumb"] == books.THUMB
    assert books.catalog()[0]["thumb"] == books.THUMB


# ── Прогресс и выписки ──


def test_позиция_и_выписки_складываются_и_отдаются(books):
    meta = books.ingest(make_epub(), "book.epub")
    books.store.set_position(meta["id"], "epubcfi(/6/2!/4/2)", 0.12, "Глава 1", updated=100)
    books.store.save_highlights(meta["id"], [
        {"id": "h1", "cfi": "epubcfi(/6/2!/4/2,/1:0,/1:9)", "text": "цитата",
         "color": "imp", "chapter": "Глава 1", "thread": [{"role": "me", "text": "?"}],
         "created": 50, "updated": 50},
    ])
    assert books.store.position(meta["id"])["pct"] == 0.12
    got = books.store.highlights(meta["id"])
    assert len(got) == 1 and got[0]["text"] == "цитата"
    assert got[0]["thread"] == [{"role": "me", "text": "?"}]


def test_позже_тронутое_побеждает(books):
    meta = books.ingest(make_epub(), "book.epub")
    books.store.set_position(meta["id"], "поздняя", updated=200)
    books.store.set_position(meta["id"], "ранняя", updated=100)      # пришло с отставшего устройства
    assert books.store.position(meta["id"])["cfi"] == "поздняя"
    books.store.set_position(meta["id"], "новее всех", updated=300)
    assert books.store.position(meta["id"])["cfi"] == "новее всех"


def test_удаление_выписки_надгробием_не_воскресает(books):
    meta = books.ingest(make_epub(), "book.epub")
    books.store.save_highlights(meta["id"], [{"id": "h1", "cfi": "c", "text": "т", "updated": 100}])
    books.store.save_highlights(meta["id"], [{"id": "h1", "cfi": "c", "text": "т", "updated": 200, "deleted": True}])
    assert books.store.highlights(meta["id"]) == []
    # Второе устройство ещё не знает об удалении и присылает свою старую версию
    books.store.save_highlights(meta["id"], [{"id": "h1", "cfi": "c", "text": "т", "updated": 150}])
    assert books.store.highlights(meta["id"]) == []
    assert len(books.store.highlights(meta["id"], with_deleted=True)) == 1


def test_каталог_несёт_проценты_и_число_выписок(books):
    meta = books.ingest(make_epub(), "book.epub")
    books.store.set_position(meta["id"], "cfi", 0.4, "Глава 2")
    books.store.save_highlights(meta["id"], [
        {"id": "h1", "cfi": "c", "text": "раз"}, {"id": "h2", "cfi": "c", "text": "два"},
        {"id": "h3", "cfi": "c", "text": "три", "deleted": True},
    ])
    card = books.catalog()[0]
    assert card["position"]["pct"] == 0.4
    assert card["position"]["chapter"] == "Глава 2"
    assert card["highlights"] == 2          # удалённая не в счёт


def test_удаление_книги_уносит_её_состояние(books):
    meta = books.ingest(make_epub(), "book.epub")
    books.store.set_position(meta["id"], "cfi", 0.4)
    books.store.save_highlights(meta["id"], [{"id": "h1", "cfi": "c", "text": "т"}])
    books.remove(meta["id"])
    assert books.store.position(meta["id"]) is None
    assert books.store.highlights(meta["id"], with_deleted=True) == []


# ── Переезд состояния из вики ──


def test_прогресс_переезжает_из_скрытой_страницы_вики(books):
    meta = books.ingest(make_epub(), "book.epub")
    reader = os.path.join(str(books.config.WIKI_DIR), ".reader")
    os.makedirs(reader, exist_ok=True)
    doc = {"v": 1, "books": {meta["id"]: {
        "at": 1700, "pos": "epubcfi(/6/2!/4/8)", "pct": 0.33, "chap": "Глава 1",
        "hl": [{"id": "h1", "cfi": "c1", "text": "старая выписка", "color": "no",
                "chapter": "Глава 1", "thread": [], "ts": 1500, "upd": 1600},
               {"id": "h2", "cfi": "c2", "text": "стёртая", "ts": 1500, "upd": 1650, "del": 1}]}}}
    with open(os.path.join(reader, "state.json"), "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False)

    assert books.migrate_legacy_state() == 1
    assert books.store.position(meta["id"])["cfi"] == "epubcfi(/6/2!/4/8)"
    live = books.store.highlights(meta["id"])
    assert [h["text"] for h in live] == ["старая выписка"]
    assert live[0]["color"] == "no"
    # Файл переименован — второй раз переезжать нечего
    assert not os.path.exists(os.path.join(reader, "state.json"))
    assert os.path.exists(os.path.join(reader, "state.migrated.json"))
    assert books.migrate_legacy_state() == 0


def test_чужая_книга_из_старого_состояния_не_создаётся(books):
    reader = os.path.join(str(books.config.WIKI_DIR), ".reader")
    os.makedirs(reader, exist_ok=True)
    with open(os.path.join(reader, "state.json"), "w", encoding="utf-8") as f:
        json.dump({"books": {"неизвестная": {"pos": "cfi", "hl": []}}}, f, ensure_ascii=False)
    assert books.migrate_legacy_state() == 0
    assert books.store.position("неизвестная") is None
