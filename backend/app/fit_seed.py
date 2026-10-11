"""Упражнения, с которых начинается справочник: база зала, без экзотики.

Строка: название, по-английски, главная мышца, вспомогательные, инвентарь, вид, шаг прибавки.
Шаг — на сколько растёт вес, когда повторы дошли до верхней границы: у штанги 2,5 кг,
у тяжёлых движений ногами 5, у гантелей — килограмм на руку.
"""

EXERCISES = [
    # Грудь
    ("Жим лёжа", "Bench press", "chest", ["triceps", "shoulders"], "barbell", "strength", 2.5),
    ("Жим гантелей лёжа", "Dumbbell bench press", "chest", ["triceps", "shoulders"], "dumbbell", "strength", 1),
    ("Жим на наклонной скамье", "Incline bench press", "chest", ["shoulders", "triceps"], "barbell", "strength", 2.5),
    ("Жим гантелей на наклонной скамье", "Incline dumbbell press", "chest", ["shoulders", "triceps"], "dumbbell", "strength", 1),
    ("Жим в тренажёре на грудь", "Machine chest press", "chest", ["triceps", "shoulders"], "machine", "strength", 5),
    ("Отжимания", "Push-up", "chest", ["triceps", "shoulders"], "body", "strength", 0),
    ("Отжимания на брусьях", "Dip", "chest", ["triceps", "shoulders"], "body", "strength", 2.5),
    ("Сведение рук в кроссовере", "Cable fly", "chest", [], "cable", "strength", 2.5),
    ("Сведение рук в тренажёре", "Pec deck", "chest", [], "machine", "strength", 5),
    # Спина
    ("Подтягивания", "Pull-up", "back", ["biceps"], "body", "strength", 2.5),
    ("Тяга верхнего блока", "Lat pulldown", "back", ["biceps"], "cable", "strength", 2.5),
    ("Тяга штанги в наклоне", "Barbell row", "back", ["biceps"], "barbell", "strength", 2.5),
    ("Тяга гантели в наклоне", "Dumbbell row", "back", ["biceps"], "dumbbell", "strength", 1),
    ("Тяга горизонтального блока", "Seated cable row", "back", ["biceps"], "cable", "strength", 2.5),
    ("Тяга в рычажном тренажёре", "Machine row", "back", ["biceps"], "machine", "strength", 5),
    ("Становая тяга", "Deadlift", "back", ["glutes", "hamstrings"], "barbell", "strength", 5),
    ("Гиперэкстензия", "Back extension", "back", ["glutes", "hamstrings"], "body", "strength", 2.5),
    ("Пуловер на блоке", "Cable pullover", "back", [], "cable", "strength", 2.5),
    # Плечи
    ("Жим штанги стоя", "Overhead press", "shoulders", ["triceps"], "barbell", "strength", 2.5),
    ("Жим гантелей сидя", "Seated dumbbell press", "shoulders", ["triceps"], "dumbbell", "strength", 1),
    ("Жим в тренажёре на плечи", "Machine shoulder press", "shoulders", ["triceps"], "machine", "strength", 5),
    ("Махи гантелями в стороны", "Lateral raise", "shoulders", [], "dumbbell", "strength", 1),
    ("Махи гантелями в наклоне", "Rear delt fly", "shoulders", ["back"], "dumbbell", "strength", 1),
    ("Обратные разведения в тренажёре", "Reverse pec deck", "shoulders", ["back"], "machine", "strength", 5),
    ("Тяга каната к лицу", "Face pull", "shoulders", ["back"], "cable", "strength", 2.5),
    # Руки
    ("Подъём штанги на бицепс", "Barbell curl", "biceps", ["forearms"], "barbell", "strength", 2.5),
    ("Подъём гантелей на бицепс", "Dumbbell curl", "biceps", ["forearms"], "dumbbell", "strength", 1),
    ("Молотки", "Hammer curl", "biceps", ["forearms"], "dumbbell", "strength", 1),
    ("Сгибание рук на блоке", "Cable curl", "biceps", [], "cable", "strength", 2.5),
    ("Разгибание рук на блоке", "Triceps pushdown", "triceps", [], "cable", "strength", 2.5),
    ("Французский жим", "Skull crusher", "triceps", [], "barbell", "strength", 2.5),
    ("Разгибание гантели из-за головы", "Overhead triceps extension", "triceps", [], "dumbbell", "strength", 1),
    ("Жим лёжа узким хватом", "Close-grip bench press", "triceps", ["chest", "shoulders"], "barbell", "strength", 2.5),
    # Ноги
    ("Приседания со штангой", "Back squat", "quads", ["glutes", "core"], "barbell", "strength", 5),
    ("Фронтальные приседания", "Front squat", "quads", ["glutes", "core"], "barbell", "strength", 2.5),
    ("Кубковые приседания", "Goblet squat", "quads", ["glutes"], "dumbbell", "strength", 2),
    ("Жим ногами", "Leg press", "quads", ["glutes"], "machine", "strength", 10),
    ("Гакк-приседания", "Hack squat", "quads", ["glutes"], "machine", "strength", 5),
    ("Болгарские сплит-приседания", "Bulgarian split squat", "quads", ["glutes"], "dumbbell", "strength", 1),
    ("Выпады", "Lunge", "quads", ["glutes"], "dumbbell", "strength", 1),
    ("Разгибание ног", "Leg extension", "quads", [], "machine", "strength", 5),
    ("Румынская тяга", "Romanian deadlift", "hamstrings", ["glutes", "back"], "barbell", "strength", 5),
    ("Сгибание ног лёжа", "Lying leg curl", "hamstrings", [], "machine", "strength", 5),
    ("Сгибание ног сидя", "Seated leg curl", "hamstrings", [], "machine", "strength", 5),
    ("Ягодичный мост со штангой", "Hip thrust", "glutes", ["hamstrings"], "barbell", "strength", 5),
    ("Махи гирей", "Kettlebell swing", "glutes", ["hamstrings", "back"], "kettlebell", "strength", 4),
    ("Отведение ноги на блоке", "Cable kickback", "glutes", [], "cable", "strength", 2.5),
    ("Подъём на носки стоя", "Standing calf raise", "calves", [], "machine", "strength", 5),
    ("Подъём на носки сидя", "Seated calf raise", "calves", [], "machine", "strength", 5),
    # Корпус и хват
    ("Планка", "Plank", "core", [], "body", "time", 0),
    ("Боковая планка", "Side plank", "core", [], "body", "time", 0),
    ("Скручивания", "Crunch", "core", [], "body", "strength", 0),
    ("Скручивания на блоке", "Cable crunch", "core", [], "cable", "strength", 2.5),
    ("Подъём ног в висе", "Hanging leg raise", "core", [], "body", "strength", 0),
    ("Ролик для пресса", "Ab wheel rollout", "core", [], "other", "strength", 0),
    ("Прогулка фермера", "Farmer's walk", "forearms", ["core", "back"], "dumbbell", "time", 2),
    ("Вис на перекладине", "Dead hang", "forearms", ["back"], "body", "time", 0),
]
