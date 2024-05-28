-- insertOrIgnoreFilter
INSERT INTO filters (filter) VALUES (@filter) ON CONFLICT DO NOTHING;

-- selectFilterId
SELECT id FROM filters WHERE filter = @filter;
