"""Фотографии к упражнениям «Тренировок»: по два кадра — начало и конец движения.

Источник — github.com/yuhonas/free-exercise-db (Unlicense, общественное достояние).
Кадры ужимаются до 640 пикселей и ложатся в frontend-fit/public/ex/<имя>-0.webp и -1.webp;
имя — название упражнения по-английски из fit_seed.py, строчными через дефис.

    uv run --with pillow scripts/fit_images.py

Что уже лежит, заново не качается: новое упражнение — строка в MAP и повторный запуск.
"""

import io
import json
import pathlib
import re
import urllib.parse
import urllib.request

from PIL import Image

BASE = "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/"
OUT = pathlib.Path(__file__).resolve().parent.parent / "frontend-fit/public/ex"
WIDTH = 640

# Наше название → название в базе. Третье значение — какие кадры брать, если не первые два.
MAP = {
    "Bench press": "Barbell Bench Press - Medium Grip",
    "Dumbbell bench press": "Dumbbell Bench Press",
    "Incline bench press": "Barbell Incline Bench Press - Medium Grip",
    "Incline dumbbell press": "Incline Dumbbell Press",
    "Machine chest press": "Leverage Chest Press",
    "Push-up": "Pushups",
    "Dip": "Dips - Chest Version",
    "Cable fly": "Cable Crossover",
    "Pec deck": "Butterfly",
    "Pull-up": "Pullups",
    "Lat pulldown": "Wide-Grip Lat Pulldown",
    "Barbell row": "Bent Over Barbell Row",
    "Dumbbell row": "One-Arm Dumbbell Row",
    "Seated cable row": "Seated Cable Rows",
    "Machine row": "Leverage Iso Row",
    "Deadlift": "Barbell Deadlift",
    "Back extension": "Hyperextensions (Back Extensions)",
    "Cable pullover": "Straight-Arm Pulldown",
    "Overhead press": "Standing Military Press",
    "Seated dumbbell press": "Dumbbell Shoulder Press",
    "Machine shoulder press": "Machine Shoulder (Military) Press",
    "Lateral raise": "Side Lateral Raise",
    "Rear delt fly": "Seated Bent-Over Rear Delt Raise",
    "Reverse pec deck": "Reverse Machine Flyes",
    "Face pull": "Face Pull",
    "Barbell curl": "Barbell Curl",
    "Dumbbell curl": "Dumbbell Bicep Curl",
    "Hammer curl": "Hammer Curls",
    "Cable curl": "Standing Biceps Cable Curl",
    "Triceps pushdown": "Triceps Pushdown",
    "Skull crusher": "EZ-Bar Skullcrusher",
    "Overhead triceps extension": "Standing Dumbbell Triceps Extension",
    "Close-grip bench press": "Close-Grip Barbell Bench Press",
    "Back squat": "Barbell Squat",
    "Front squat": "Front Barbell Squat",
    "Goblet squat": "Goblet Squat",
    "Leg press": "Leg Press",
    "Hack squat": "Hack Squat",
    "Bulgarian split squat": "Split Squat with Dumbbells",
    "Lunge": "Dumbbell Lunges",
    "Leg extension": "Leg Extensions",
    "Romanian deadlift": "Romanian Deadlift",
    "Lying leg curl": "Lying Leg Curls",
    "Seated leg curl": "Seated Leg Curl",
    "Hip thrust": "Barbell Hip Thrust",
    "Kettlebell swing": "One-Arm Kettlebell Swings",
    "Cable kickback": "One-Legged Cable Kickback",
    "Standing calf raise": "Standing Calf Raises",
    "Seated calf raise": "Seated Calf Raise",
    "Plank": "Plank",
    "Side plank": "Side Bridge",
    "Crunch": "Crunches",
    "Cable crunch": "Cable Crunch",
    "Hanging leg raise": "Hanging Leg Raise",
    "Ab wheel rollout": "Ab Roller",
    "Farmer's walk": "Farmer's Walk",
    # Виса в базе нет: это нижняя точка подтягивания, оба кадра одинаковые.
    "Dead hang": ("Pullups", (0, 0)),
}


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(BASE + "dist/exercises.json") as r:
        db = {e["name"]: e for e in json.load(r)}
    for ours, theirs in MAP.items():
        theirs, frames = theirs if isinstance(theirs, tuple) else (theirs, (0, 1))
        for n, frame in enumerate(frames):
            dst = OUT / f"{slug(ours)}-{n}.webp"
            if dst.exists():
                continue
            url = BASE + "exercises/" + urllib.parse.quote(db[theirs]["images"][frame])
            with urllib.request.urlopen(url) as r:
                im = Image.open(io.BytesIO(r.read())).convert("RGB")
            im.thumbnail((WIDTH, WIDTH))
            im.save(dst, "WEBP", quality=68, method=6)
            print(dst.name)


if __name__ == "__main__":
    main()
