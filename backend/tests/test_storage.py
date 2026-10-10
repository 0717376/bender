"""Файловое хранилище: загрузка и просьба агенту разобрать файлы."""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pytest.fixture
def api(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app import config, storage_api

    monkeypatch.setattr(config, "FILES_DIR", str(tmp_path))
    monkeypatch.setattr(config, "WIKI_PASSWORD", "пароль")
    monkeypatch.setattr(config, "AUTH_TOKEN", "tok3n")
    app = FastAPI()
    app.include_router(storage_api.router)
    client = TestClient(app)
    client.headers["Authorization"] = "Bearer tok3n"
    return client


def upload(api, name: str, body: bytes = b"data", folder: str = "Входящие") -> str:
    r = api.post("/storage/upload", params={"dir": folder}, files={"file": (name, body)})
    assert r.status_code == 200, r.text
    return r.json()["path"]


def test_upload_keeps_both_files_with_same_name(api, tmp_path):
    first, second = upload(api, "отчёт.pdf"), upload(api, "отчёт.pdf", b"other")
    assert first == "Входящие/отчёт.pdf" and second != first
    assert (tmp_path / first).read_bytes() == b"data" and (tmp_path / second).read_bytes() == b"other"


def test_parse_prompt_carries_the_real_path(api, tmp_path):
    """Путь внутри контейнера знает только сервер — клиенту его зашивать нельзя."""
    rel = upload(api, "отчёт.pdf")
    prompt = api.post("/storage/parse-prompt", json={"paths": [rel]}).json()["prompt"]
    assert str(tmp_path / rel) in prompt and "Read" in prompt


def test_parse_prompt_is_one_request_for_many_files(api, tmp_path):
    paths = [upload(api, "a.txt"), upload(api, "b.txt")]
    prompt = api.post("/storage/parse-prompt", json={"paths": paths}).json()["prompt"]
    assert all(f"- {tmp_path / p}" in prompt for p in paths)


def test_parse_prompt_rejects_missing_and_outside_paths(api):
    assert api.post("/storage/parse-prompt", json={"paths": []}).status_code == 400
    assert api.post("/storage/parse-prompt", json={"paths": ["нет.txt"]}).status_code == 404
    assert api.post("/storage/parse-prompt", json={"paths": ["../../etc/passwd"]}).status_code in (400, 403, 404)
    assert api.post("/storage/parse-prompt", json={"paths": ["x"]},
                    headers={"Authorization": "Bearer nope"}).status_code == 401
