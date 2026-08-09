"""Повторяющиеся задачи: правила, шаблон и раскладка копий вперёд."""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import repeat  # noqa: E402


# --- Правило: даты ---

def occ(rule, after, until, limit=12):
    return repeat.occurrences(repeat.norm(rule), after, until, limit)


def test_every_day():
    assert occ({"unit": "day", "interval": 1, "start": "2026-03-01"}, "2026-03-01", "2026-03-04") == [
        "2026-03-02", "2026-03-03", "2026-03-04"]


def test_every_third_day_keeps_the_grid():
    """Курсор в середине интервала не сбивает сетку: даты остаются кратны старту."""
    assert occ({"unit": "day", "interval": 3, "start": "2026-03-01"}, "2026-03-05", "2026-03-12") == [
        "2026-03-07", "2026-03-10"]


def test_weekdays():
    """«По вторникам и четвергам» — два дня в неделю, а не «каждые 7 дней»."""
    assert occ({"unit": "week", "interval": 1, "weekdays": [2, 4], "start": "2026-03-02"},
               "2026-03-02", "2026-03-13") == [
        "2026-03-03", "2026-03-05", "2026-03-10", "2026-03-12"]


def test_every_other_week():
    assert occ({"unit": "week", "interval": 2, "weekdays": [1], "start": "2026-03-02"},
               "2026-03-02", "2026-04-14") == ["2026-03-16", "2026-03-30", "2026-04-13"]


def test_week_without_weekdays_uses_the_start_day():
    assert occ({"unit": "week", "interval": 1, "start": "2026-03-04"}, "2026-03-04", "2026-03-20") == [
        "2026-03-11", "2026-03-18"]


def test_monthday_clamps_to_short_months():
    assert occ({"unit": "month", "interval": 1, "monthday": 31, "start": "2026-01-31"},
               "2026-01-31", "2026-04-30") == ["2026-02-28", "2026-03-31", "2026-04-30"]


def test_last_day_of_month():
    assert occ({"unit": "month", "interval": 1, "monthday": "last", "start": "2026-01-01"},
               "2026-01-01", "2026-03-31") == ["2026-01-31", "2026-02-28", "2026-03-31"]


def test_second_tuesday():
    assert occ({"unit": "month", "interval": 1, "nth": [2, 2], "start": "2026-01-01"},
               "2026-01-01", "2026-03-31") == ["2026-01-13", "2026-02-10", "2026-03-10"]


def test_last_friday():
    assert occ({"unit": "month", "interval": 1, "nth": [-1, 5], "start": "2026-01-01"},
               "2026-01-01", "2026-02-28") == ["2026-01-30", "2026-02-27"]


def test_fifth_monday_is_skipped_when_the_month_has_none():
    """Пятого понедельника в феврале 2026 нет — месяц пропускается, сетка не съезжает."""
    got = occ({"unit": "month", "interval": 1, "nth": [4, 1], "start": "2026-01-01"},
              "2026-01-01", "2026-03-31")
    assert got == ["2026-01-26", "2026-02-23", "2026-03-23"]


def test_yearly_on_a_fixed_date():
    assert occ({"unit": "year", "interval": 1, "month": 3, "monthday": 12, "start": "2026-01-01"},
               "2026-01-01", "2028-12-31") == ["2026-03-12", "2027-03-12", "2028-03-12"]


def test_end_on_date_cuts_the_tail():
    assert occ({"unit": "day", "interval": 1, "start": "2026-03-01", "end": {"on": "2026-03-03"}},
               "2026-03-01", "2026-03-10") == ["2026-03-02", "2026-03-03"]


def test_after_completion_has_no_calendar():
    assert occ({"unit": "day", "interval": 3, "mode": "done", "start": "2026-03-01"},
               "2026-03-01", "2026-04-01") == []


def test_norm_drops_garbage():
    assert repeat.norm({"unit": "century"}) is None
    assert repeat.norm({}) is None
    r = repeat.norm({"unit": "week", "interval": "900", "weekdays": [0, 3, 3, 9], "mode": "wat"})
    assert r == {"unit": "week", "interval": 1, "mode": "schedule", "weekdays": [3]}


def test_norm_keeps_monthday_over_nth():
    r = repeat.norm({"unit": "month", "interval": 1, "monthday": 15, "nth": [2, 2]})
    assert r["monthday"] == 15 and "nth" not in r


# --- Хранилище: шаблон и копии ---

@pytest.fixture
def store(tmp_path, monkeypatch):
    from app import config, tasks_store

    monkeypatch.setattr(config, "DATA_DIR", str(tmp_path / "data"))
    tasks_store.init()
    return tasks_store


def today(store):
    return store._today()


def shifted(store, days):
    from datetime import date, timedelta
    return (date.fromisoformat(store._today()) + timedelta(days=days)).isoformat()


def test_creating_a_repeating_task_lays_out_the_next_ones(store):
    t = store.create_task("Полить цветы", when="today", repeat={"unit": "day", "interval": 1})
    assert t["repeat_parent"], "задача стала первым экземпляром своего повтора"

    upcoming = store.list_tasks(view="upcoming")
    assert [x["when_date"] for x in upcoming] == [shifted(store, 1), shifted(store, 2), shifted(store, 3)]
    # шаблон в обычные списки не лезет
    assert all(x["kind"] == "task" for x in store.list_tasks(view="today") + upcoming)
    tpl = store.list_tasks(view="repeats")
    assert len(tpl) == 1 and tpl[0]["next_date"] == today(store)


def test_occurrences_appear_without_completing_anything(store):
    """Ради этого всё и затевалось: ежемесячная задача идёт по календарю сама."""
    store.create_task("Оплатить квартиру", when="today", repeat={"unit": "month", "interval": 1})
    dates = [x["when_date"] for x in store.list_tasks(view="upcoming")]
    assert len(dates) == 3 and dates[0] > today(store)


def test_skipping_one_occurrence_keeps_the_chain(store):
    store.create_task("Зарядка", when="today", repeat={"unit": "day", "interval": 1})
    victim = store.list_tasks(view="upcoming")[0]
    store.delete_task(victim["id"])
    left = [x["when_date"] for x in store.list_tasks(view="upcoming")]
    assert victim["when_date"] not in left and len(left) == 3


def test_completing_does_not_duplicate_scheduled_occurrences(store):
    store.create_task("Зарядка", when="today", repeat={"unit": "day", "interval": 1})
    first = store.list_tasks(view="today")[0]
    store.complete_task(first["id"])
    assert len(store.list_tasks(view="upcoming")) == 3


def test_after_completion_mode_waits_for_the_deed(store):
    store.create_task("Помыть окна", when="today", repeat={"unit": "day", "interval": 10, "mode": "done"})
    assert store.list_tasks(view="upcoming") == []
    first = store.list_tasks(view="today")[0]
    store.complete_task(first["id"])
    nxt = store.list_tasks(view="upcoming")
    assert len(nxt) == 1 and nxt[0]["when_date"] == shifted(store, 10)


def test_end_after_n_stops_the_template(store):
    store.create_task("Курс витаминов", when="today",
                      repeat={"unit": "day", "interval": 1, "end": {"after": 3}})
    dates = [x["when_date"] for x in store.list_tasks(view="today") + store.list_tasks(view="upcoming")]
    assert dates == [today(store), shifted(store, 1), shifted(store, 2)]
    assert store.list_tasks(view="repeats"), "шаблон жив, пока копии не выполнены"
    for x in store.list_tasks(view="today") + store.list_tasks(view="upcoming"):
        store.complete_task(x["id"])
    assert store.list_tasks(view="repeats") == []


def test_changing_the_rule_rebuilds_the_future(store):
    t = store.create_task("Отчёт", when="today", repeat={"unit": "day", "interval": 1})
    store.update_task(t["id"], repeat={"unit": "week", "interval": 1})
    dates = [x["when_date"] for x in store.list_tasks(view="upcoming")]
    assert dates == [shifted(store, 7), shifted(store, 14), shifted(store, 21)]


def test_removing_the_rule_leaves_a_plain_task(store):
    t = store.create_task("Отчёт", when="today", repeat={"unit": "day", "interval": 1})
    store.update_task(t["id"], repeat={})
    assert store.list_tasks(view="repeats") == []
    assert store.list_tasks(view="upcoming") == []
    left = store.list_tasks(view="today")
    assert len(left) == 1 and left[0]["repeat"] is None


def test_removing_the_rule_from_a_future_copy_keeps_that_copy(store):
    """Снимают повтор — не задачу: та, из которой сняли, остаётся даже будучи в будущем."""
    store.create_task("Отчёт", when="today", repeat={"unit": "day", "interval": 1})
    future = store.list_tasks(view="upcoming")[0]
    store.update_task(future["id"], repeat={})
    left = store.list_tasks(view="upcoming")
    assert [x["id"] for x in left] == [future["id"]]
    assert left[0]["repeat"] is None and store.list_tasks(view="repeats") == []


def test_deleting_the_template_takes_the_future_with_it(store):
    store.create_task("Зарядка", when="today", repeat={"unit": "day", "interval": 1})
    tpl = store.list_tasks(view="repeats")[0]
    store.delete_task(tpl["id"])
    assert store.list_tasks(view="upcoming") == []
    store.restore_task(tpl["id"])
    assert len(store.list_tasks(view="upcoming")) == 3


def test_repeat_on_an_existing_dateless_task_gives_it_a_date(store):
    t = store.create_task("Проверить бэкапы")
    store.update_task(t["id"], repeat={"unit": "week", "interval": 1, "weekdays": [1]})
    got = store.get_task(t["id"])
    assert got["when_date"] and got["repeat_parent"]


def test_old_repeating_tasks_migrate_to_templates(store, tmp_path, monkeypatch):
    """База с прежней схемой: правило переезжает на шаблон, задача остаётся на месте."""
    import json
    import sqlite3

    from app import config, tasks_store

    store._conn.close()
    old_dir = tmp_path / "legacy"
    old_dir.mkdir()
    conn = sqlite3.connect(str(old_dir / "tasks.db"))
    conn.executescript(tasks_store.SCHEMA)
    conn.execute("ALTER TABLE tasks ADD COLUMN repeat TEXT")
    conn.execute("ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'task'")
    conn.execute("ALTER TABLE tasks ADD COLUMN triaged INTEGER NOT NULL DEFAULT 0")
    conn.execute("ALTER TABLE tasks ADD COLUMN deleted_at TEXT")
    conn.execute("ALTER TABLE tasks ADD COLUMN spawned_id INTEGER")
    conn.execute("INSERT INTO tasks(title,when_date,repeat,sort,created_at,triaged) VALUES(?,?,?,1,?,1)",
                 ("Оплатить интернет", "2026-01-10",
                  json.dumps({"unit": "month", "interval": 1, "mode": "schedule"}), "2026-01-01"))
    conn.commit()
    conn.close()

    monkeypatch.setattr(config, "DATA_DIR", str(old_dir))
    tasks_store._ensured_day = None
    tasks_store.init()
    tpl = tasks_store.list_tasks(view="repeats")
    assert len(tpl) == 1 and tpl[0]["repeat"]["unit"] == "month"
    assert len(tasks_store.list_tasks(view="upcoming")) == 3
