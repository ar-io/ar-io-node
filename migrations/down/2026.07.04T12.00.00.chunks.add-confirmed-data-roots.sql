-- Down migration: drop the sticky-confirmation marker table.
DROP TABLE IF EXISTS confirmed_data_roots;
