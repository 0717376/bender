"""Планировщик карточек — FSRS, тот же алгоритм, что в нынешнем Anki.

У каждой карточки две величины: устойчивость (за сколько дней вероятность вспомнить падает
до 90%) и сложность. После ответа они пересчитываются, а следующий показ ставится на тот
день, когда вероятность вспомнить опустится до заданной — её и называют «удержанием».
Выше удержание — чаще повторы; 0.9 — разумная середина.

Считает библиотека fsrs; здесь — перевод между её объектами и строкой базы. Время в базе —
миллисекунды эпохи, у библиотеки — datetime в UTC.
"""

from datetime import datetime, timedelta, timezone

from fsrs import Card, Rating, Scheduler, State

NEW = 0
# Новая и забытая карточка сначала проходят короткие шаги в пределах одной сессии
# и только потом уходят на дни: с первого раза в долгую память ничего не ложится.
LEARNING_STEPS = (timedelta(minutes=1), timedelta(minutes=10))
RELEARNING_STEPS = (timedelta(minutes=10),)
MAX_INTERVAL = 36500


def _dt(ms: int) -> datetime:
    return datetime.fromtimestamp(ms / 1000, timezone.utc)


def _ms(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)


def _scheduler(retention: float, params, fuzz: bool) -> Scheduler:
    kw = {"parameters": tuple(params)} if params else {}
    return Scheduler(desired_retention=retention or 0.9, learning_steps=LEARNING_STEPS,
                     relearning_steps=RELEARNING_STEPS, maximum_interval=MAX_INTERVAL,
                     enable_fuzzing=fuzz, **kw)


def _card(row, t: int) -> Card:
    """Строка базы → карточка библиотеки. Новая карточка для неё — заучиваемая с нуля."""
    if row["state"] == NEW:
        return Card(card_id=row["id"], due=_dt(t))
    return Card(card_id=row["id"], state=State(row["state"]), step=row["step"],
                stability=row["stability"], difficulty=row["difficulty"],
                due=_dt(row["due"]), last_review=_dt(row["last_review"]) if row["last_review"] else None)


def review(row, rating: int, t: int, retention: float = 0.9, params=None) -> dict:
    """Новое состояние карточки после ответа. Интервал слегка размывается: карточки,
    выученные в один день, не должны вечно приходить одной пачкой."""
    card, _ = _scheduler(retention, params, True).review_card(_card(row, t), Rating(rating), _dt(t))
    return {"state": card.state.value, "step": card.step, "stability": card.stability,
            "difficulty": card.difficulty, "due": _ms(card.due)}


def preview(row, t: int, retention: float = 0.9, params=None) -> dict[int, int]:
    """Через сколько секунд карточка вернётся при каждой из четырёх оценок — подписи
    на кнопках. Без размытия: подпись не должна прыгать от показа к показу."""
    sched = _scheduler(retention, params, False)
    out = {}
    for r in (1, 2, 3, 4):
        card, _ = sched.review_card(_card(row, t), Rating(r), _dt(t))
        out[r] = max(0, int((_ms(card.due) - t) / 1000))
    return out


def retrievability(row, t: int) -> float:
    """Вероятность вспомнить карточку прямо сейчас (0…1)."""
    if row["state"] == NEW or not row["stability"] or not row["last_review"]:
        return 0.0
    return _scheduler(0.9, None, False).get_card_retrievability(_card(row, t), _dt(t))
