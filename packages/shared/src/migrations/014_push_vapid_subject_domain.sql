UPDATE settings
SET value = 'mailto:admin@tv-eg.com'
WHERE key = 'push_vapid_subject'
  AND (
    value IS NULL
    OR trim(value) = ''
    OR lower(value) LIKE '%localhost%'
    OR lower(value) LIKE '%127.0.0.1%'
    OR lower(value) LIKE '%[::1]%'
    OR (
      lower(value) NOT LIKE 'mailto:%'
      AND lower(value) NOT LIKE 'https://%'
    )
  );
