"""Карточки: планировщик, очередь дня, заметки, ручки, заполнение агентом."""

import asyncio
import os
import sys
from datetime import datetime

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

DAY = 86400000
MIN = 60000


def at(day: int, hour: int = 12, minute: int = 0) -> int:
    """Момент в миллисекундах: день января 2026-го по часам сервера."""
    return int(datetime(2026, 1, day, hour, minute).timestamp() * 1000)


@pytest.fixture
def store(tmp_path, monkeypatch):
    from app import cards_store, config

    monkeypatch.setattr(config, "DATA_DIR", str(tmp_path))
    cards_store.init()
    return cards_store


@pytest.fixture
def api(store, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app import cards_api, config

    monkeypatch.setattr(config, "WIKI_PASSWORD", "пароль")
    monkeypatch.setattr(config, "AUTH_TOKEN", "tok3n")
    app = FastAPI()
    app.include_router(cards_api.events_router)
    app.include_router(cards_api.router)
    client = TestClient(app)
    client.headers["Authorization"] = "Bearer tok3n"
    return client


def word(store, w="serendipity", meaning="счастливая случайность", **kw):
    return store.create_note("word", {"word": w, "meaning": meaning,
                                      "example": f"It was pure {w}."}, **kw)


def learn(store, card_id, t):
    """Довести новую карточку до выученной: «хорошо» на каждом шаге заучивания."""
    for _ in range(5):
        res = store.answer(card_id, 3, t=t)
        if res["state"] == store.REVIEW:
            return res
        t = res["due"]
    raise AssertionError("карточка не выучилась за пять ответов")


# ── Заметки и карточки ──

def test_word_gives_two_cards_and_default_deck(store):
    n = word(store)
    assert [c["tpl"] for c in store.note_cards(n["id"])] == ["fwd", "rev"]
    assert store.deck(n["deck_id"])["name"] == "Слова"


def test_basic_and_reverse(store):
    one = store.create_note("basic", {"front": "2+2", "back": "4"})
    two = store.create_note("basic", {"front": "H2O", "back": "вода", "reverse": True})
    assert len(store.note_cards(one["id"])) == 1
    assert [c["tpl"] for c in store.note_cards(two["id"])] == ["fwd", "rev"]
    assert store.deck(one["deck_id"])["name"] == "Разное"


def test_cloze_card_per_number(store):
    n = store.create_note("cloze", {"text": "Столица {{c1::Франции}} — {{c2::Париж::город}}."})
    assert [c["tpl"] for c in store.note_cards(n["id"])] == ["c1", "c2"]
    f = store.faces("cloze", n["fields"], "c2")
    assert f["front"] == "Столица Франции — [город]."
    assert f["back"] == "Столица Франции — **Париж**."


@pytest.mark.parametrize("kind,fields", [
    ("word", {"word": "cat"}), ("basic", {"front": "вопрос"}),
    ("cloze", {"text": "без пропусков"}), ("poem", {"front": "a", "back": "b"}),
])
def test_incomplete_note_is_rejected(store, kind, fields):
    with pytest.raises(ValueError):
        store.create_note(kind, fields)


def test_word_faces_hide_the_word_in_reverse(store):
    n = word(store)
    fwd, rev = (store.faces("word", n["fields"], t) for t in ("fwd", "rev"))
    assert "serendipity" in fwd["front"] and "счастливая случайность" in fwd["back"]
    assert "serendipity" not in rev["front"] and "____" in rev["front"]
    assert "serendipity" in rev["back"]


def test_edit_keeps_progress_and_syncs_cloze_cards(store):
    n = store.create_note("cloze", {"text": "{{c1::A}} и {{c2::B}}"})
    first = store.note_cards(n["id"])[0]["id"]
    learn(store, first, at(1))
    store.update_note(n["id"], fields={"text": "{{c1::A}} и {{c3::C}}"})
    cards = store.note_cards(n["id"])
    assert [c["tpl"] for c in cards] == ["c1", "c3"]
    assert cards[0]["id"] == first and cards[0]["state"] == store.REVIEW   # выученное цело


def test_deck_by_name_is_reused_case_insensitively(store):
    a = store.create_note("basic", {"front": "a", "back": "b"}, deck="Физика")
    b = store.create_note("basic", {"front": "c", "back": "d"}, deck="физика")
    assert a["deck_id"] == b["deck_id"] and len(store.decks()) == 1


def test_search_ignores_case_in_cyrillic(store):
    store.create_note("basic", {"front": "Энтропия", "back": "мера беспорядка"})
    store.create_note("basic", {"front": "Импульс", "back": "масса на скорость"})
    assert [n["fields"]["front"] for n in store.list_notes(q="энтроп")] == ["Энтропия"]


# ── Планировщик ──

def test_new_card_walks_learning_steps_then_graduates(store):
    n = store.create_note("basic", {"front": "a", "back": "b"})
    cid = store.note_cards(n["id"])[0]["id"]
    t = at(1)
    r1 = store.answer(cid, 3, t=t)
    assert r1["state"] == store.LEARNING and r1["due"] - t == 10 * MIN
    r2 = store.answer(cid, 3, t=r1["due"])
    assert r2["state"] == store.REVIEW and r2["due"] - r1["due"] >= DAY


def test_intervals_grow_and_lapse_sends_back_to_relearning(store):
    n = store.create_note("basic", {"front": "a", "back": "b"})
    cid = store.note_cards(n["id"])[0]["id"]
    res = learn(store, cid, at(1))
    gaps = []
    for _ in range(4):
        t = res["due"]
        res = store.answer(cid, 3, t=t)
        gaps.append(res["due"] - t)
    assert gaps == sorted(gaps) and gaps[-1] > gaps[0] * 2      # интервалы растут
    t = res["due"]
    lapse = store.answer(cid, 1, t=t)
    assert lapse["state"] == store.RELEARNING and lapse["due"] - t == 10 * MIN
    assert store.note_cards(n["id"])[0]["lapses"] == 1


def test_preview_orders_ratings(store):
    n = store.create_note("basic", {"front": "a", "back": "b"})
    cid = store.note_cards(n["id"])[0]["id"]
    learn(store, cid, at(1))
    iv = store.card(cid, at(20))["intervals"]
    assert iv[1] < iv[2] <= iv[3] < iv[4]


def test_easier_retention_means_longer_intervals(store):
    lazy = store.create_deck("Лёгкая", retention=0.8)
    strict = store.create_deck("Строгая", retention=0.95)
    due = {}
    for d in (lazy, strict):
        n = store.create_note("basic", {"front": "a", "back": "b"}, deck=d["id"])
        cid = store.note_cards(n["id"])[0]["id"]
        learn(store, cid, at(1))
        due[d["name"]] = store.card(cid, at(1))["intervals"][3]
    assert due["Лёгкая"] > due["Строгая"]


def test_leech_is_suspended_and_can_be_revived(store):
    n = store.create_note("basic", {"front": "a", "back": "b"})
    cid = store.note_cards(n["id"])[0]["id"]
    res = learn(store, cid, at(1))
    flagged = False
    for _ in range(store.LEECH_LAPSES):
        again = store.answer(cid, 1, t=res["due"])
        flagged = flagged or again["leech"]
        res = learn(store, cid, again["due"])
    c = store.note_cards(n["id"])[0]
    assert flagged and c["leech"] and c["suspended"]
    assert store.next_card(t=res["due"] + DAY) is None           # в очередь больше не идёт
    store.set_suspended(cid, False)
    c = store.note_cards(n["id"])[0]
    assert not c["leech"] and not c["suspended"] and c["lapses"] == 0


# ── Очередь дня ──

def test_reverse_card_waits_for_forward_and_is_buried_same_day(store):
    n = word(store)
    fwd, rev = (c["id"] for c in store.note_cards(n["id"]))
    t = at(1)
    assert store.counts(t=t)["new"] == 1                 # обратная пока не в счёт
    assert store.next_card(t=t)["id"] == fwd
    learn(store, fwd, t)
    # Прямая выучена, но обратную сегодня не показываем — ответ только что видели.
    assert store.next_card(t=at(1, 13)) is None
    assert store.next_card(t=at(2))["id"] == rev


def test_daily_new_limit_per_deck(store):
    d = store.create_deck("Мало", new_per_day=2)
    ids = [store.note_cards(store.create_note("basic", {"front": str(i), "back": "x"},
                                              deck=d["id"])["id"])[0]["id"] for i in range(5)]
    t = at(1)
    assert store.counts(t=t)["new"] == 2
    store.answer(ids[0], 3, t=t)
    store.answer(ids[1], 3, t=t)
    assert store.counts(t=t)["new"] == 0                 # норма на сегодня выбрана
    assert store.counts(t=at(2))["new"] == 2             # завтра — следующие


def test_day_rolls_over_at_four_not_midnight(store):
    assert store.day_of(at(2, 1)) == store.day_of(at(1, 23))     # час ночи — ещё «вчера»
    assert store.day_of(at(2, 5)) != store.day_of(at(1, 23))
    d = store.create_deck("Одна", new_per_day=1)
    for i in range(2):
        store.create_note("basic", {"front": str(i), "back": "x"}, deck=d["id"])
    first = store.next_card(t=at(1, 23))
    store.answer(first["id"], 3, t=at(1, 23))
    assert store.counts(t=at(2, 1))["new"] == 0
    assert store.counts(t=at(2, 5))["new"] == 1


def test_queue_order_learning_then_review_then_new(store):
    old = store.create_note("basic", {"front": "старая", "back": "x"})
    old_id = store.note_cards(old["id"])[0]["id"]
    res = learn(store, old_id, at(1))
    t = res["due"] + MIN
    fresh = store.create_note("basic", {"front": "новая", "back": "x"})
    step = store.create_note("basic", {"front": "в работе", "back": "x"})
    step_id = store.note_cards(step["id"])[0]["id"]
    store.answer(step_id, 1, t=t - 5 * MIN)              # срок доучивания уже подошёл
    order = []
    for _ in range(3):
        c = store.next_card(t=t)
        order.append(c["fields"]["front"])
        store.answer(c["id"], 4, t=t)
    assert order == ["в работе", "старая", "новая"]
    assert fresh["id"] and store.next_card(t=t) is None


def test_learning_card_is_served_early_when_nothing_else(store):
    n = store.create_note("basic", {"front": "a", "back": "b"})
    cid = store.note_cards(n["id"])[0]["id"]
    t = at(1)
    store.answer(cid, 3, t=t)                            # следующий шаг через 10 минут
    assert store.next_card(t=t + MIN)["id"] == cid       # ждать незачем — показываем
    store.answer(cid, 1, t=t + MIN)
    assert store.waiting(t=t + MIN) == t + 2 * MIN


def test_undo_restores_card_and_unburies_sibling(store):
    n = word(store)
    fwd, rev = (c["id"] for c in store.note_cards(n["id"]))
    t = store.now()
    store.answer(fwd, 4, t=t)
    assert store.note_cards(n["id"])[1]["state"] == store.NEW
    assert store.undo() == {"card_id": fwd}
    c = store.note_cards(n["id"])[0]
    assert c["state"] == store.NEW and c["reps"] == 0
    assert store.next_card(t=t)["id"] == fwd and store.undo() is None
    assert rev


def test_deleted_and_suspended_leave_the_queue(store):
    a = store.create_note("basic", {"front": "a", "back": "b"})
    b = store.create_note("basic", {"front": "c", "back": "d"})
    store.delete_note(a["id"])
    store.set_suspended(store.note_cards(b["id"])[0]["id"], True)
    assert store.counts()["total"] == 0


# ── Сводка ──

def test_overview_streak_and_stats(store):
    n = store.create_note("basic", {"front": "a", "back": "b"})
    cid = store.note_cards(n["id"])[0]["id"]
    res = learn(store, cid, at(1))
    store.answer(cid, 3, t=at(2))
    o = store.overview(t=at(2, 13))
    assert o["streak"] == {"current": 2, "best": 2}
    assert o["today"]["n"] == 1 and o["decks"][0]["cards"] == 1
    assert sum(d["n"] for d in o["forecast"]) == 1
    s = store.stats(t=at(2, 13))
    assert s["retention"] == {"seen": 1, "kept": 1, "rate": 1.0}
    assert s["maturity"]["young"] == 1 and res["state"] == store.REVIEW
    # День без повторов серию ещё не рвёт, второй — рвёт.
    assert store.overview(t=at(3, 9))["streak"]["current"] == 2
    assert store.overview(t=at(4, 9))["streak"]["current"] == 0


def test_settings_are_clamped(store):
    s = store.save_settings({"notify_hour": 99, "retention": 0.2, "new_per_day": -5, "junk": 1})
    assert s["notify_hour"] == 23 and s["retention"] == 0.7 and s["new_per_day"] == 0
    assert "junk" not in s


# ── Ручки ──

def test_api_requires_auth(api):
    assert api.get("/cards/overview", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert api.get("/cards/events?token=nope").status_code == 401


def test_api_review_round(api, store):
    made = api.post("/cards/notes", json={"kind": "basic", "fields": {"front": "a", "back": "b"}}).json()
    s = api.get("/cards/next").json()
    assert s["card"]["front"] == "a" and s["counts"]["new"] == 1
    assert set(s["card"]["intervals"]) == {"1", "2", "3", "4"}
    after = api.post(f"/cards/{s['card']['id']}/answer", json={"rating": 3, "duration": 1500}).json()
    assert after["result"]["state"] == store.LEARNING and after["counts"]["learning"] == 1
    back = api.post("/cards/undo").json()
    assert back["card"]["id"] == s["card"]["id"] and back["counts"]["new"] == 1
    assert api.post(f"/cards/{s['card']['id']}/answer", json={"rating": 7}).status_code == 400
    assert api.post("/cards/notes", json={"kind": "basic", "fields": {"front": "a"}}).status_code == 400
    one = api.get(f"/cards/notes/{made['id']}").json()
    assert one["fields"]["front"] == "a" and [c["tpl"] for c in one["cards"]] == ["fwd"]
    assert api.delete(f"/cards/notes/{made['id']}").json() == {"ok": True}
    assert api.get(f"/cards/notes/{made['id']}").status_code == 404
    assert api.get("/cards/next").json()["card"] is None


def test_version_bumps_on_write(store):
    v = store.version()
    store.create_note("basic", {"front": "a", "back": "b"})
    assert store.version() > v


# ── Быстрое добавление ──

REPLY = ('Вот карточка:\n```json\n{"kind": "word", "fields": {"word": "serendipity", '
         '"lemma": "serendipity", "ipa": "/ˌserənˈdɪpɪti/", "pos": "noun", '
         '"meaning": "счастливая случайность", "example": "It was pure serendipity."}}\n```')


def test_quick_add_makes_draft_then_agent_fills_it(store, monkeypatch):
    from app import agent, cards_enrich

    seen = {}

    async def fake(prompt, surface="telegram"):
        seen.update(prompt=prompt, surface=surface)
        return REPLY

    monkeypatch.setattr(agent, "run_cron", fake)

    async def go():
        n = cards_enrich.quick("serendipity", "It was pure serendipity. Nothing else.",
                               {"id": "b1", "title": "Книга", "chapter": "Глава 2"}, "epubcfi(/6/2)")
        assert n["status"] == "draft" and not store.note_cards(n["id"])
        assert store.counts()["total"] == 0              # черновик не спрашивают
        await asyncio.gather(*cards_enrich._tasks)
        return n["id"]

    nid = asyncio.run(go())
    n = store.note(nid)
    assert n["status"] == "ready" and n["fields"]["meaning"] == "счастливая случайность"
    assert len(store.note_cards(nid)) == 2 and n["source"]["book_id"] == "b1"
    assert "Глава 2" in seen["prompt"] and "It was pure serendipity" in seen["prompt"]
    assert seen["surface"] == "cards"


def test_long_selection_becomes_a_fact_card_in_another_deck(store, monkeypatch):
    from app import agent, cards_enrich

    async def fake(prompt, surface="telegram"):
        return '{"kind": "cloze", "fields": {"text": "Сложность {{c1::накапливается}} по мелочи."}}'

    monkeypatch.setattr(agent, "run_cron", fake)

    async def go():
        n = cards_enrich.quick("Сложность накапливается по мелочи, по одному решению за раз.")
        await asyncio.gather(*cards_enrich._tasks)
        return n["id"]

    n = store.note(asyncio.run(go()))
    assert n["kind"] == "cloze" and n["status"] == "ready"
    assert store.deck(n["deck_id"])["name"] == "Разное"


def test_failed_fill_stays_in_inbox_and_can_be_retried(store, monkeypatch):
    from app import agent, cards_enrich

    replies = iter(["не знаю такого слова", REPLY])

    async def fake(prompt, surface="telegram"):
        return next(replies)

    monkeypatch.setattr(agent, "run_cron", fake)

    async def go():
        n = cards_enrich.quick("serendipity")
        await asyncio.gather(*cards_enrich._tasks)
        assert store.note(n["id"])["status"] == "failed"
        assert [x["id"] for x in store.list_notes(status="inbox")] == [n["id"]]
        store.redraft_note(n["id"])
        cards_enrich.enqueue(n["id"])
        await asyncio.gather(*cards_enrich._tasks)
        return n["id"]

    assert store.note(asyncio.run(go()))["status"] == "ready"


# ── Инструменты агента ──

def test_tools_add_batch_reports_bad_notes(store):
    from app import cards_tools

    out = cards_tools.add([
        {"kind": "word", "fields": {"word": "cat", "meaning": "кошка"}},
        {"kind": "basic", "fields": {"front": "только вопрос"}},
        {"kind": "cloze", "fields": {"text": "{{c1::Земля}} круглая"}},
    ], deck="Проба")
    assert len(out["added"]) == 2 and out["errors"][0]["index"] == 1
    summary = cards_tools.due()
    assert summary["decks"][0]["name"] == "Проба" and summary["due"]["new"] == 2
    found = [cards_tools.brief(n) for n in store.list_notes(q="кошка")]
    assert found[0]["fields"]["word"] == "cat" and found[0]["leech"] is False
