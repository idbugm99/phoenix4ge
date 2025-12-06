-- ============================================================================
-- Color Palette Standardization Migration
-- ============================================================================
-- This migration standardizes all color palettes to use exactly 15 tokens
-- with consistent naming across all themes.
--
-- Standard 15 Tokens:
--   1. primary           - Main brand color (buttons, navigation, CTAs)
--   2. secondary         - Secondary brand color
--   3. accent            - Highlights, links, badges
--   4. background        - Main page background
--   5. surface           - Cards, panels, modals
--   6. surface-alt       - Alternate surface (zebra rows, hover states)
--   7. text              - Primary body text
--   8. text-subtle       - Muted/secondary text
--   9. text-light        - Very light text (placeholders, disabled)
--  10. text-inverse      - Text on colored backgrounds (white on buttons)
--  11. border            - Default borders
--  12. border-light      - Subtle dividers
--  13. success           - Form validation, success messages
--  14. danger            - Form errors, destructive actions
--  15. info              - Informational callouts
-- ============================================================================

-- Step 1: Backup existing data
CREATE TABLE IF NOT EXISTS color_palette_values_backup_20251206 AS
SELECT * FROM color_palette_values;

-- Step 2: Rename inconsistent token names to standard names
-- Remove duplicate 'bg' where 'background' already exists
DELETE FROM color_palette_values
WHERE token_name = 'bg'
AND palette_id IN (
    SELECT palette_id FROM (
        SELECT palette_id FROM color_palette_values WHERE token_name = 'background'
    ) AS temp
);

-- Rename remaining 'bg' to 'background'
UPDATE color_palette_values
SET token_name = 'background',
    token_description = 'Main page background'
WHERE token_name = 'bg';

-- Rename 'bg-alt' to 'surface-alt'
UPDATE color_palette_values
SET token_name = 'surface-alt',
    token_description = 'Alternate surface (zebra rows, hover states)'
WHERE token_name = 'bg-alt';

-- Remove duplicate 'border-muted' where 'border-light' already exists
DELETE FROM color_palette_values
WHERE token_name = 'border-muted'
AND palette_id IN (
    SELECT palette_id FROM (
        SELECT palette_id FROM color_palette_values WHERE token_name = 'border-light'
    ) AS temp
);

-- Rename remaining 'border-muted' to 'border-light'
UPDATE color_palette_values
SET token_name = 'border-light',
    token_description = 'Subtle dividers'
WHERE token_name = 'border-muted';

-- Step 3: Remove non-standard tokens (will be handled in CSS with color-mix())
DELETE FROM color_palette_values
WHERE token_name IN (
    'bg-dark', 'bg-light',
    'btn-bg', 'btn-bg-hover', 'btn-border', 'btn-text', 'btn-text-hover',
    'card-bg', 'card-border', 'card-shadow', 'card-text',
    'text-dark',
    'focus', 'focus-ring', 'overlay',
    'warning'
);

-- Step 4: Add missing standard tokens for each palette
-- Add 'text-light' if missing (calculate as lighter version of text)
INSERT INTO color_palette_values (palette_id, token_name, token_description, token_value)
SELECT
    p.id as palette_id,
    'text-light' as token_name,
    'Very light text (placeholders, disabled)' as token_description,
    COALESCE(
        (SELECT token_value FROM color_palette_values
         WHERE palette_id = p.id AND token_name = 'text-subtle'),
        '#9CA3AF'
    ) as token_value
FROM color_palettes p
WHERE NOT EXISTS (
    SELECT 1 FROM color_palette_values
    WHERE palette_id = p.id AND token_name = 'text-light'
);

-- Add 'text-inverse' if missing (white text for colored backgrounds)
INSERT INTO color_palette_values (palette_id, token_name, token_description, token_value)
SELECT
    p.id as palette_id,
    'text-inverse' as token_name,
    'Text on colored backgrounds (white on buttons)' as token_description,
    '#FFFFFF' as token_value
FROM color_palettes p
WHERE NOT EXISTS (
    SELECT 1 FROM color_palette_values
    WHERE palette_id = p.id AND token_name = 'text-inverse'
);

-- Add 'info' if missing (use accent or blue)
INSERT INTO color_palette_values (palette_id, token_name, token_description, token_value)
SELECT
    p.id as palette_id,
    'info' as token_name,
    'Informational callouts' as token_description,
    COALESCE(
        (SELECT token_value FROM color_palette_values
         WHERE palette_id = p.id AND token_name = 'accent'),
        '#3B82F6'
    ) as token_value
FROM color_palettes p
WHERE NOT EXISTS (
    SELECT 1 FROM color_palette_values
    WHERE palette_id = p.id AND token_name = 'info'
);

-- Add 'background' if missing (use bg or white)
INSERT INTO color_palette_values (palette_id, token_name, token_description, token_value)
SELECT
    p.id as palette_id,
    'background' as token_name,
    'Main page background' as token_description,
    '#FFFFFF' as token_value
FROM color_palettes p
WHERE NOT EXISTS (
    SELECT 1 FROM color_palette_values
    WHERE palette_id = p.id AND token_name = 'background'
);

-- Add 'surface' if missing
INSERT INTO color_palette_values (palette_id, token_name, token_description, token_value)
SELECT
    p.id as palette_id,
    'surface' as token_name,
    'Cards, panels, modals' as token_description,
    COALESCE(
        (SELECT token_value FROM color_palette_values
         WHERE palette_id = p.id AND token_name = 'background'),
        '#FFFFFF'
    ) as token_value
FROM color_palettes p
WHERE NOT EXISTS (
    SELECT 1 FROM color_palette_values
    WHERE palette_id = p.id AND token_name = 'surface'
);

-- Add 'surface-alt' if missing
INSERT INTO color_palette_values (palette_id, token_name, token_description, token_value)
SELECT
    p.id as palette_id,
    'surface-alt' as token_name,
    'Alternate surface (zebra rows, hover states)' as token_description,
    COALESCE(
        (SELECT token_value FROM color_palette_values
         WHERE palette_id = p.id AND token_name = 'surface'),
        '#F9FAFB'
    ) as token_value
FROM color_palettes p
WHERE NOT EXISTS (
    SELECT 1 FROM color_palette_values
    WHERE palette_id = p.id AND token_name = 'surface-alt'
);

-- Step 5: Update token descriptions to be consistent
UPDATE color_palette_values SET token_description = 'Main brand color (buttons, navigation, CTAs)' WHERE token_name = 'primary';
UPDATE color_palette_values SET token_description = 'Secondary brand color' WHERE token_name = 'secondary';
UPDATE color_palette_values SET token_description = 'Highlights, links, badges' WHERE token_name = 'accent';
UPDATE color_palette_values SET token_description = 'Main page background' WHERE token_name = 'background';
UPDATE color_palette_values SET token_description = 'Cards, panels, modals' WHERE token_name = 'surface';
UPDATE color_palette_values SET token_description = 'Alternate surface (zebra rows, hover states)' WHERE token_name = 'surface-alt';
UPDATE color_palette_values SET token_description = 'Primary body text' WHERE token_name = 'text';
UPDATE color_palette_values SET token_description = 'Muted/secondary text' WHERE token_name = 'text-subtle';
UPDATE color_palette_values SET token_description = 'Very light text (placeholders, disabled)' WHERE token_name = 'text-light';
UPDATE color_palette_values SET token_description = 'Text on colored backgrounds (white on buttons)' WHERE token_name = 'text-inverse';
UPDATE color_palette_values SET token_description = 'Default borders' WHERE token_name = 'border';
UPDATE color_palette_values SET token_description = 'Subtle dividers' WHERE token_name = 'border-light';
UPDATE color_palette_values SET token_description = 'Form validation, success messages' WHERE token_name = 'success';
UPDATE color_palette_values SET token_description = 'Form errors, destructive actions' WHERE token_name = 'danger';
UPDATE color_palette_values SET token_description = 'Informational callouts' WHERE token_name = 'info';

-- Step 6: Verification - Show token count per palette
SELECT
    palette_id,
    COUNT(*) as token_count,
    GROUP_CONCAT(token_name ORDER BY token_name SEPARATOR ', ') as tokens
FROM color_palette_values
GROUP BY palette_id
ORDER BY palette_id;

-- Expected result: All palettes should have exactly 15 tokens with standard names
