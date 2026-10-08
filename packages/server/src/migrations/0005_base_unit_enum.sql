-- ============================================================
-- 0005_base_unit_enum.sql · 基本单位收敛为枚举 EA / KG / M / L / ROLL
-- 存量中文单位按语义回填：件类 → EA，千克类 → KG，米 → M，升 → L，卷 → ROLL
-- 仅做数据回填（SQLite 无法用 ALTER 追加 CHECK），写入侧由 zod 枚举兜底
-- ============================================================

UPDATE item SET base_unit = 'EA' WHERE base_unit IN ('件', '只', '个', '块', '张', '套', '台', '支', '根');
UPDATE item SET base_unit = 'KG' WHERE base_unit IN ('千克', '公斤');
UPDATE item SET base_unit = 'M' WHERE base_unit = '米';
UPDATE item SET base_unit = 'L' WHERE base_unit = '升';
UPDATE item SET base_unit = 'ROLL' WHERE base_unit = '卷';
UPDATE item SET base_unit = UPPER(base_unit) WHERE base_unit IN ('ea', 'kg', 'm', 'l', 'roll');