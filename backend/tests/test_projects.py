"""Проекты: удаление списка не должно уносить задачи."""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pytest.fixture
def store(tmp_path, monkeypatch):
    from app import config, tasks_store

    monkeypatch.setattr(config, "DATA_DIR", str(tmp_path / "data"))
    tasks_store.init()
    return tasks_store


def test_deleting_a_project_keeps_its_tasks(store):
    pid = store.create_project("Ремонт")
    t = store.create_task("Купить краску", project=pid)
    store.delete_project(pid)

    assert [p["id"] for p in store.list_projects()] == []
    left = store.get_task(t["id"])
    assert left and left["project_id"] is None
    # задача без проекта, но уже разобранная — ей место в «В любое время», не во «Входящих»
    assert [x["id"] for x in store.list_tasks(view="anytime")] == [t["id"]]


def test_deleting_a_project_takes_its_repeat_templates_along(store):
    """Шаблон повтора — такая же строка задач: он отвязывается, а не исчезает."""
    pid = store.create_project("Быт")
    store.create_task("Вынести мусор", when="today", project=pid,
                      repeat={"unit": "day", "interval": 1})
    store.delete_project(pid)
    tpl = store.list_tasks(view="repeats")
    assert len(tpl) == 1 and tpl[0]["project_id"] is None
    assert len(store.list_tasks(view="upcoming")) == 3
