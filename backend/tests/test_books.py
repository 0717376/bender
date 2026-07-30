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
              cover=True, chapters=2, broken=False, nav=True, ncx=False):
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
        if nav:      # оглавление epub3: само в корешок не входит, главой не считается
            links = "".join(f'<li><a href="c{i}.xhtml">Часть {i}</a></li>'
                            for i in range(1, chapters + 1))
            z.writestr("OEBPS/nav.xhtml",
                       '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" '
                       'xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Оглавление</title></head>'
                       f'<body><nav epub:type="toc"><ol>{links}</ol></nav></body></html>')
            items.append('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>')
        if ncx:      # оглавление epub2
            points = "".join(f'<navPoint id="n{i}"><navLabel><text>Раздел {i}</text></navLabel>'
                             f'<content src="c{i}.xhtml"/></navPoint>' for i in range(1, chapters + 1))
            z.writestr("OEBPS/toc.ncx",
                       '<?xml version="1.0" encoding="utf-8"?><ncx version="2005-1" '
                       f'xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>{points}</navMap></ncx>')
            items.append('<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>')
        z.writestr("OEBPS/content.opf",
                   '<?xml version="1.0" encoding="utf-8"?>'
                   '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bid">'
                   '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
                   f"<dc:identifier id=\"bid\">urn:test</dc:identifier><dc:title>{title}</dc:title>"
                   f"<dc:creator>{author}</dc:creator><dc:language>ru</dc:language></metadata>"
                   f"<manifest>{''.join(items)}</manifest><spine>{''.join(refs)}</spine></package>")
    return buf.getvalue()


@pytest.fixture
def api(books, monkeypatch):
    """Ручки книг через HTTP: проверяем то, ради чего они и существуют, — авторизацию."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app import config

    monkeypatch.setattr(config, "WIKI_PASSWORD", "пароль")
    monkeypatch.setattr(config, "AUTH_TOKEN", "tok3n")
    app = FastAPI()
    app.include_router(books.router)
    return TestClient(app)


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


# ── Отдача файлов ──


def test_файл_книги_отдаётся_и_по_заголовку_и_по_токену(api, books):
    """Обложке токен ставят в query (<img> заголовок не умеет), а файл книги забирает
    fetch — и шлёт Bearer. Принимаем оба: иначе книга открывается только из кэша."""
    meta = books.ingest(make_epub(), "book.epub")
    url = f"/books/{meta['id']}/file"
    assert api.get(url).status_code == 401
    assert api.get(url + "?token=tok3n").status_code == 200
    ok = api.get(url, headers={"Authorization": "Bearer tok3n"})
    assert ok.status_code == 200 and ok.content[:2] == b"PK"
    assert api.get(url, headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert api.get(url, headers={"Authorization": "tok3n"}).status_code == 401


def test_обложка_и_миниатюра_тоже_принимают_заголовок(api, books):
    meta = books.ingest(make_epub(), "book.epub")
    head = {"Authorization": "Bearer tok3n"}
    assert api.get(f"/books/{meta['id']}/cover", headers=head).status_code == 200
    assert api.get(f"/books/{meta['id']}/cover").status_code == 401
    assert api.get(f"/books/{meta['id']}/thumb", headers=head).status_code == 404   # ещё не слали
    assert api.get(f"/books/{meta['id']}/thumb").status_code == 401


def test_без_токена_не_видно_какие_книги_есть(api, books):
    books.ingest(make_epub(), "book.epub")
    # И у существующей, и у выдуманной книги ответ один и тот же — иначе библиотека
    # просматривается по кодам ответа.
    assert api.get("/books/nosuchbook/file").status_code == 401
    assert api.get("/books/nosuchbook/file?token=tok3n").status_code == 404


# ── Книга глазами агента ──


def test_оглавление_берёт_названия_из_nav(books):
    meta = books.ingest(make_epub(chapters=3), "book.epub")
    toc = books.chapters(meta["id"])
    assert [c["n"] for c in toc] == [1, 2, 3]
    assert [c["title"] for c in toc] == ["Часть 1", "Часть 2", "Часть 3"]
    assert all(c["chars"] > 0 for c in toc)


def test_оглавление_берёт_названия_из_ncx(books):
    meta = books.ingest(make_epub(nav=False, ncx=True), "book.epub")
    assert [c["title"] for c in books.chapters(meta["id"])] == ["Раздел 1", "Раздел 2"]


def test_глава_без_оглавления_подписана_первой_строкой(books):
    meta = books.ingest(make_epub(nav=False), "book.epub")
    assert books.chapters(meta["id"])[0]["title"].startswith("Глава 1")


def test_книге_прошлой_версии_оглавление_собирается_на_лету(books):
    meta = books.ingest(make_epub(), "book.epub")
    os.unlink(os.path.join(str(books.config.BOOKS_DIR), meta["id"], books.CHAPTERS))
    toc = books.chapters(meta["id"])
    assert [c["n"] for c in toc] == [1, 2]
    assert toc[0]["title"].startswith("Глава 1")      # файла нет — подписали текстом


def test_книге_прошлой_версии_оглавление_досылается_при_старте(books):
    meta = books.ingest(make_epub(), "book.epub")
    path = os.path.join(str(books.config.BOOKS_DIR), meta["id"], books.CHAPTERS)
    os.unlink(path)
    books.init()
    assert os.path.isfile(path)
    assert [c["title"] for c in books.chapters(meta["id"])] == ["Часть 1", "Часть 2"]
    assert books.backfill_chapters(meta["id"]) is False      # второй раз собирать нечего


def test_разошедшийся_текст_глав_оглавление_не_подделывает(books):
    meta = books.ingest(make_epub(chapters=3), "book.epub")
    root = os.path.join(str(books.config.BOOKS_DIR), meta["id"])
    os.unlink(os.path.join(root, books.CHAPTERS))
    os.unlink(os.path.join(root, "text", "003.txt"))
    assert books.backfill_chapters(meta["id"]) is False


def test_текст_главы_читается_по_номеру(books):
    from fastapi import HTTPException

    meta = books.ingest(make_epub(), "book.epub")
    assert "потом читает агент" in books.chapter_text(meta["id"], 2)
    with pytest.raises(HTTPException) as e:
        books.chapter_text(meta["id"], 9)
    assert e.value.status_code == 404


def test_поиск_по_книге_даёт_главу_и_фрагмент(books):
    from fastapi import HTTPException

    meta = books.ingest(make_epub(chapters=3), "book.epub")
    hits = books.search(meta["id"], "потом читает")
    assert len(hits) == 3
    assert hits[0]["chapter"] == 1 and hits[0]["title"] == "Часть 1"
    assert "потом читает" in hits[0]["text"]
    assert books.search(meta["id"], "такого в книге нет") == []
    assert len(books.search(meta["id"], "глава", limit=2)) == 2        # регистр не важен
    assert len(books.search(meta["id"], r"Глава \d", regex=True)) == 3
    with pytest.raises(HTTPException):
        books.search(meta["id"], "[", regex=True)
    with pytest.raises(HTTPException):
        books.search(meta["id"], "  ")


def test_инструменты_агента_видят_полку_и_главы(books):
    from app import books_tools

    meta = books.ingest(make_epub(), "book.epub")
    books.store.set_position(meta["id"], "cfi", 0.25, "Часть 1")
    card = books_tools.catalog()[0]
    assert card["id"] == meta["id"] and card["chapters"] == 2
    assert card["read_pct"] == 25 and card["reading_chapter"] == "Часть 1"

    head = books_tools.read(meta["id"], 1, 0, 20)
    assert head["title"] == "Часть 1" and head["more"] is True and len(head["text"]) == 20
    tail = books_tools.read(meta["id"], 1, head["next_offset"])
    assert tail["offset"] == 20 and tail["more"] is False
    assert head["text"] + tail["text"] == books.chapter_text(meta["id"], 1)


def test_выписки_агенту_идут_со_смыслом_цвета(books):
    from app import books_tools

    meta = books.ingest(make_epub(), "book.epub")
    books.store.save_highlights(meta["id"], [
        {"id": "h1", "cfi": "c", "text": "цитата", "color": "no", "chapter": "Часть 1",
         "thread": [{"role": "me", "text": "почему?"}], "created": 1700000000000,
         "updated": 1700000000000},
        {"id": "h2", "cfi": "c", "text": "стёртая", "color": "imp", "deleted": True},
    ])
    got = books_tools.highlights(meta["id"])
    assert [h["text"] for h in got] == ["цитата"]         # надгробие агенту не показываем
    assert got[0]["meaning"] == "Не согласен"
    assert got[0]["talk"][0]["text"] == "почему?"
    assert got[0]["date"].startswith("20")
    assert books_tools.highlights(meta["id"], color="imp") == []


def test_книга_доезжает_до_промпта_агента(books):
    from app.chat import with_context

    meta = books.ingest(make_epub(), "book.epub")
    out = with_context("Объясни", {"book": {"id": meta["id"], "title": "Проверка чтения",
                                            "author": "Тестовый Автор", "chapter": "Часть 1"}})
    assert meta["id"] in out and "Проверка чтения" in out and "Часть 1" in out
    assert out.endswith("Объясни")
    assert with_context("Просто вопрос", {}) == "Просто вопрос"
