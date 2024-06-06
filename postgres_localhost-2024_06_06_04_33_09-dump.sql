--
-- PostgreSQL database dump
--

-- Dumped from database version 15.3 (Debian 15.3-1.pgdg120+1)
-- Dumped by pg_dump version 16.3

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: fuzzystrmatch; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS fuzzystrmatch WITH SCHEMA public;


--
-- Name: EXTENSION fuzzystrmatch; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION fuzzystrmatch IS 'determine similarities and distance between strings';


--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: is_valid_utf8(bytea); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.is_valid_utf8(input_bytea bytea) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
declare
    input_text text;
begin
    input_text := convert_from(input_bytea, 'UTF8');
    RETURN true;
exception
    when others then
        return false;
end;
$$;


ALTER FUNCTION public.is_valid_utf8(input_bytea bytea) OWNER TO postgres;

--
-- Name: url_safe_base64_encode(bytea); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.url_safe_base64_encode(input bytea) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
    encoded TEXT;
BEGIN
    -- Standard base64 encoding
    encoded := encode(input, 'base64');

    -- Remove any trailing '=' characters
    encoded := rtrim(encoded, '=');

    -- Replace '+' with '-'
    encoded := replace(encoded, '+', '-');

    -- Replace '/' with '_'
    encoded := replace(encoded, '/', '_');

    RETURN encoded;
END;
$$;


ALTER FUNCTION public.url_safe_base64_encode(input bytea) OWNER TO postgres;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: block_sources; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.block_sources (
    id bigint NOT NULL,
    name text,
    created_at bigint
);


ALTER TABLE public.block_sources OWNER TO postgres;

--
-- Name: blocked_hashes; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.blocked_hashes (
    hash bytea NOT NULL,
    block_source_id bigint,
    notes text,
    blocked_at bigint
);


ALTER TABLE public.blocked_hashes OWNER TO postgres;

--
-- Name: blocked_ids; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.blocked_ids (
    id bytea NOT NULL,
    block_source_id bigint,
    notes text,
    blocked_at bigint
);


ALTER TABLE public.blocked_ids OWNER TO postgres;

--
-- Name: bundle_data_items; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.bundle_data_items (
    id bytea NOT NULL,
    parent_id bytea NOT NULL,
    parent_index bigint NOT NULL,
    filter_id bigint NOT NULL,
    root_transaction_id bytea,
    first_indexed_at bigint,
    last_indexed_at bigint
);


ALTER TABLE public.bundle_data_items OWNER TO postgres;

--
-- Name: bundle_formats; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.bundle_formats (
    id bigint NOT NULL,
    format text
);


ALTER TABLE public.bundle_formats OWNER TO postgres;

--
-- Name: bundles; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.bundles (
    id bytea NOT NULL,
    format_id bigint,
    unbundle_filter_id bigint,
    index_filter_id bigint,
    data_item_count bigint,
    matched_data_item_count bigint,
    first_queued_at bigint,
    last_queued_at bigint,
    first_skipped_at bigint,
    last_skipped_at bigint,
    first_unbundled_at bigint,
    last_unbundled_at bigint,
    first_fully_indexed_at bigint,
    last_fully_indexed_at bigint,
    root_transaction_id bytea,
    import_attempt_count bigint
);


ALTER TABLE public.bundles OWNER TO postgres;

--
-- Name: contiguous_data; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.contiguous_data (
    hash bytea NOT NULL,
    data_size bigint,
    original_source_content_type text,
    indexed_at bigint,
    cached_at bigint
);


ALTER TABLE public.contiguous_data OWNER TO postgres;

--
-- Name: contiguous_data_id_parents; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.contiguous_data_id_parents (
    id bytea NOT NULL,
    parent_id bytea NOT NULL,
    data_offset bigint,
    data_size bigint,
    indexed_at bigint
);


ALTER TABLE public.contiguous_data_id_parents OWNER TO postgres;

--
-- Name: contiguous_data_ids; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.contiguous_data_ids (
    id bytea NOT NULL,
    contiguous_data_hash bytea,
    verified boolean DEFAULT false,
    indexed_at bigint,
    verified_at bigint
);


ALTER TABLE public.contiguous_data_ids OWNER TO postgres;

--
-- Name: contiguous_data_parents; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.contiguous_data_parents (
    hash bytea NOT NULL,
    parent_hash bytea NOT NULL,
    data_offset bigint,
    indexed_at bigint
);


ALTER TABLE public.contiguous_data_parents OWNER TO postgres;

--
-- Name: data_roots; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.data_roots (
    data_root bytea NOT NULL,
    contiguous_data_hash bytea,
    verified boolean DEFAULT false,
    indexed_at bigint,
    verified_at bigint
);


ALTER TABLE public.data_roots OWNER TO postgres;

--
-- Name: filters; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.filters (
    id bigint NOT NULL,
    filter text
);


ALTER TABLE public.filters OWNER TO postgres;

--
-- Name: migrations; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.migrations (
    name text NOT NULL,
    executed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.migrations OWNER TO postgres;

--
-- Name: missing_transactions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.missing_transactions (
    block_indep_hash bytea NOT NULL,
    transaction_id bytea NOT NULL,
    height bigint
);


ALTER TABLE public.missing_transactions OWNER TO postgres;

--
-- Name: new_block_transactions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.new_block_transactions (
    block_indep_hash bytea NOT NULL,
    transaction_id bytea NOT NULL,
    block_transaction_index bigint NOT NULL,
    height bigint
);


ALTER TABLE public.new_block_transactions OWNER TO postgres;

--
-- Name: new_blocks; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.new_blocks (
    indep_hash bytea NOT NULL,
    height bigint,
    previous_block bytea,
    nonce bytea,
    hash bytea,
    block_timestamp bigint,
    diff text,
    cumulative_diff text,
    last_retarget bigint,
    reward_addr bytea,
    reward_pool text,
    block_size bigint,
    weave_size bigint,
    usd_to_ar_rate_dividend bigint,
    usd_to_ar_rate_divisor bigint,
    scheduled_usd_to_ar_rate_dividend bigint,
    scheduled_usd_to_ar_rate_divisor bigint,
    hash_list_merkle bytea,
    wallet_list bytea,
    tx_root bytea,
    tx_count bigint,
    missing_tx_count bigint
);


ALTER TABLE public.new_blocks OWNER TO postgres;

--
-- Name: new_data_item_tags; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.new_data_item_tags (
    tag_name_hash bytea NOT NULL,
    tag_value_hash bytea NOT NULL,
    root_transaction_id bytea NOT NULL,
    data_item_id bytea NOT NULL,
    data_item_tag_index bigint NOT NULL,
    height bigint,
    indexed_at bigint
);


ALTER TABLE public.new_data_item_tags OWNER TO postgres;

--
-- Name: new_data_items; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.new_data_items (
    id bytea NOT NULL,
    parent_id bytea,
    root_transaction_id bytea,
    height bigint,
    signature bytea,
    anchor bytea,
    owner_address bytea,
    target bytea,
    data_offset bigint,
    data_size bigint,
    content_type text,
    tag_count bigint,
    indexed_at bigint
);


ALTER TABLE public.new_data_items OWNER TO postgres;

--
-- Name: new_transaction_tags; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.new_transaction_tags (
    tag_name_hash bytea NOT NULL,
    tag_value_hash bytea NOT NULL,
    transaction_id bytea NOT NULL,
    transaction_tag_index bigint NOT NULL,
    height bigint,
    indexed_at bigint
);


ALTER TABLE public.new_transaction_tags OWNER TO postgres;

--
-- Name: new_transactions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.new_transactions (
    id bytea NOT NULL,
    signature bytea,
    format bigint,
    last_tx bytea,
    owner_address bytea,
    target bytea,
    quantity text,
    reward text,
    data_size bigint,
    data_root bytea,
    content_type text,
    tag_count bigint,
    indexed_at bigint,
    height bigint
);


ALTER TABLE public.new_transactions OWNER TO postgres;

--
-- Name: stable_block_transactions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.stable_block_transactions (
    block_indep_hash bytea NOT NULL,
    transaction_id bytea NOT NULL,
    block_transaction_index bigint NOT NULL
);


ALTER TABLE public.stable_block_transactions OWNER TO postgres;

--
-- Name: stable_blocks; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.stable_blocks (
    height bigint NOT NULL,
    indep_hash bytea,
    previous_block bytea,
    nonce bytea,
    hash bytea,
    block_timestamp bigint,
    diff text,
    cumulative_diff text,
    last_retarget bigint,
    reward_addr bytea,
    reward_pool text,
    block_size bigint,
    weave_size bigint,
    usd_to_ar_rate_dividend bigint,
    usd_to_ar_rate_divisor bigint,
    scheduled_usd_to_ar_rate_dividend bigint,
    scheduled_usd_to_ar_rate_divisor bigint,
    hash_list_merkle bytea,
    wallet_list bytea,
    tx_root bytea,
    tx_count bigint,
    missing_tx_count bigint
);


ALTER TABLE public.stable_blocks OWNER TO postgres;

--
-- Name: stable_data_item_tags; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.stable_data_item_tags (
    tag_name_hash bytea,
    tag_value_hash bytea,
    height bigint,
    block_transaction_index bigint,
    data_item_tag_index bigint,
    data_item_id bytea,
    parent_id bytea,
    root_transaction_id bytea
);


ALTER TABLE public.stable_data_item_tags OWNER TO postgres;

--
-- Name: stable_data_items; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.stable_data_items (
    id bytea NOT NULL,
    parent_id bytea,
    root_transaction_id bytea,
    height bigint,
    block_transaction_index bigint,
    signature bytea,
    anchor bytea,
    owner_address bytea,
    target bytea,
    data_offset bigint,
    data_size bigint,
    content_type text,
    tag_count bigint,
    indexed_at bigint
);


ALTER TABLE public.stable_data_items OWNER TO postgres;

--
-- Name: stable_transaction_tags; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.stable_transaction_tags (
    tag_name_hash bytea NOT NULL,
    tag_name bytea,
    tag_value_hash bytea NOT NULL,
    tag_value bytea,
    height bigint NOT NULL,
    block_transaction_index bigint NOT NULL,
    transaction_tag_index bigint NOT NULL,
    transaction_id bytea
);


ALTER TABLE public.stable_transaction_tags OWNER TO postgres;

--
-- Name: stable_transactions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.stable_transactions (
    id bytea NOT NULL,
    height bigint,
    block_transaction_index bigint,
    signature bytea,
    format bigint,
    last_tx bytea,
    owner_address bytea,
    target bytea,
    quantity text,
    reward text,
    data_size bigint,
    data_root bytea,
    content_type text,
    tag_count bigint,
    "offset" bigint
);


ALTER TABLE public.stable_transactions OWNER TO postgres;

--
-- Name: tag_names; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.tag_names (
    hash bytea NOT NULL,
    name bytea
);


ALTER TABLE public.tag_names OWNER TO postgres;

--
-- Name: tag_values; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.tag_values (
    hash bytea NOT NULL,
    value bytea
);


ALTER TABLE public.tag_values OWNER TO postgres;

--
-- Name: wallets; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.wallets (
    address bytea NOT NULL,
    public_modulus bytea
);


ALTER TABLE public.wallets OWNER TO postgres;

--
-- Name: migrations idx_16496_sqlite_autoindex_migrations_1; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.migrations
    ADD CONSTRAINT idx_16496_sqlite_autoindex_migrations_1 PRIMARY KEY (name);


--
-- Name: stable_block_transactions idx_16507_sqlite_autoindex_stable_block_transactions_1; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.stable_block_transactions
    ADD CONSTRAINT idx_16507_sqlite_autoindex_stable_block_transactions_1 PRIMARY KEY (block_indep_hash, transaction_id, block_transaction_index);


--
-- Name: stable_transactions idx_16512_sqlite_autoindex_stable_transactions_1; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.stable_transactions
    ADD CONSTRAINT idx_16512_sqlite_autoindex_stable_transactions_1 PRIMARY KEY (id);


--
-- Name: missing_transactions idx_16517_sqlite_autoindex_missing_transactions_1; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.missing_transactions
    ADD CONSTRAINT idx_16517_sqlite_autoindex_missing_transactions_1 PRIMARY KEY (block_indep_hash, transaction_id);


--
-- Name: new_blocks idx_16532_sqlite_autoindex_new_blocks_1; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.new_blocks
    ADD CONSTRAINT idx_16532_sqlite_autoindex_new_blocks_1 PRIMARY KEY (indep_hash);


--
-- Name: new_transactions idx_16537_sqlite_autoindex_new_transactions_1; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.new_transactions
    ADD CONSTRAINT idx_16537_sqlite_autoindex_new_transactions_1 PRIMARY KEY (id);


--
-- Name: new_block_transactions idx_16542_sqlite_autoindex_new_block_transactions_1; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.new_block_transactions
    ADD CONSTRAINT idx_16542_sqlite_autoindex_new_block_transactions_1 PRIMARY KEY (block_indep_hash, transaction_id, block_transaction_index);


--
-- Name: new_transaction_tags idx_16547_sqlite_autoindex_new_transaction_tags_1; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.new_transaction_tags
    ADD CONSTRAINT idx_16547_sqlite_autoindex_new_transaction_tags_1 PRIMARY KEY (tag_name_hash, tag_value_hash, transaction_id, transaction_tag_index);


--
-- Name: stable_blocks idx_16552_stable_blocks_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.stable_blocks
    ADD CONSTRAINT idx_16552_stable_blocks_pkey PRIMARY KEY (height);


--
-- Name: stable_transaction_tags idx_16557_sqlite_autoindex_stable_transaction_tags_1; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.stable_transaction_tags
    ADD CONSTRAINT idx_16557_sqlite_autoindex_stable_transaction_tags_1 PRIMARY KEY (tag_name_hash, tag_value_hash, height, block_transaction_index, transaction_tag_index);


--
-- Name: bundle_formats idx_20392_bundle_formats_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.bundle_formats
    ADD CONSTRAINT idx_20392_bundle_formats_pkey PRIMARY KEY (id);


--
-- Name: wallets idx_20397_sqlite_autoindex_wallets_1; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.wallets
    ADD CONSTRAINT idx_20397_sqlite_autoindex_wallets_1 PRIMARY KEY (address);


--
-- Name: stable_data_items idx_20402_sqlite_autoindex_stable_data_items_1; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.stable_data_items
    ADD CONSTRAINT idx_20402_sqlite_autoindex_stable_data_items_1 PRIMARY KEY (id);


--
-- Name: tag_names idx_20407_sqlite_autoindex_tag_names_1; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tag_names
    ADD CONSTRAINT idx_20407_sqlite_autoindex_tag_names_1 PRIMARY KEY (hash);


--
-- Name: tag_values idx_20412_sqlite_autoindex_tag_values_1; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tag_values
    ADD CONSTRAINT idx_20412_sqlite_autoindex_tag_values_1 PRIMARY KEY (hash);


--
-- Name: new_data_items idx_20422_sqlite_autoindex_new_data_items_1; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.new_data_items
    ADD CONSTRAINT idx_20422_sqlite_autoindex_new_data_items_1 PRIMARY KEY (id);


--
-- Name: new_data_item_tags idx_20427_sqlite_autoindex_new_data_item_tags_1; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.new_data_item_tags
    ADD CONSTRAINT idx_20427_sqlite_autoindex_new_data_item_tags_1 PRIMARY KEY (tag_name_hash, tag_value_hash, root_transaction_id, data_item_id, data_item_tag_index);


--
-- Name: bundle_data_items idx_20432_sqlite_autoindex_bundle_data_items_1; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.bundle_data_items
    ADD CONSTRAINT idx_20432_sqlite_autoindex_bundle_data_items_1 PRIMARY KEY (id, parent_id, parent_index, filter_id);


--
-- Name: filters idx_20437_filters_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.filters
    ADD CONSTRAINT idx_20437_filters_pkey PRIMARY KEY (id);


--
-- Name: bundles idx_20442_sqlite_autoindex_bundles_1; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.bundles
    ADD CONSTRAINT idx_20442_sqlite_autoindex_bundles_1 PRIMARY KEY (id);


--
-- Name: block_sources idx_29048_block_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.block_sources
    ADD CONSTRAINT idx_29048_block_sources_pkey PRIMARY KEY (id);


--
-- Name: blocked_ids idx_29053_sqlite_autoindex_blocked_ids_1; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.blocked_ids
    ADD CONSTRAINT idx_29053_sqlite_autoindex_blocked_ids_1 PRIMARY KEY (id);


--
-- Name: blocked_hashes idx_29058_sqlite_autoindex_blocked_hashes_1; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.blocked_hashes
    ADD CONSTRAINT idx_29058_sqlite_autoindex_blocked_hashes_1 PRIMARY KEY (hash);


--
-- Name: contiguous_data idx_29075_sqlite_autoindex_contiguous_data_1; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contiguous_data
    ADD CONSTRAINT idx_29075_sqlite_autoindex_contiguous_data_1 PRIMARY KEY (hash);


--
-- Name: contiguous_data_ids idx_29080_sqlite_autoindex_contiguous_data_ids_1; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contiguous_data_ids
    ADD CONSTRAINT idx_29080_sqlite_autoindex_contiguous_data_ids_1 PRIMARY KEY (id);


--
-- Name: data_roots idx_29086_sqlite_autoindex_data_roots_1; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.data_roots
    ADD CONSTRAINT idx_29086_sqlite_autoindex_data_roots_1 PRIMARY KEY (data_root);


--
-- Name: contiguous_data_parents idx_29092_sqlite_autoindex_contiguous_data_parents_1; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contiguous_data_parents
    ADD CONSTRAINT idx_29092_sqlite_autoindex_contiguous_data_parents_1 PRIMARY KEY (hash, parent_hash);


--
-- Name: contiguous_data_id_parents idx_29097_sqlite_autoindex_contiguous_data_id_parents_1; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contiguous_data_id_parents
    ADD CONSTRAINT idx_29097_sqlite_autoindex_contiguous_data_id_parents_1 PRIMARY KEY (id, parent_id);


--
-- Name: new_transactions unique_transaction_id; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.new_transactions
    ADD CONSTRAINT unique_transaction_id UNIQUE (id);


--
-- Name: new_transaction_tags uniquetransacton_tag; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.new_transaction_tags
    ADD CONSTRAINT uniquetransacton_tag UNIQUE (tag_name_hash, tag_value_hash, transaction_id);


--
-- Name: idx_16507_sable_block_transactions_transaction_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_16507_sable_block_transactions_transaction_id_idx ON public.stable_block_transactions USING btree (transaction_id);


--
-- Name: idx_16512_stable_transactions_id_height_block_transaction_index; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_16512_stable_transactions_id_height_block_transaction_index ON public.stable_transactions USING btree (height, block_transaction_index);


--
-- Name: idx_16512_stable_transactions_offset_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_16512_stable_transactions_offset_idx ON public.stable_transactions USING btree ("offset");


--
-- Name: idx_16512_stable_transactions_owner_address_height_block_transa; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_16512_stable_transactions_owner_address_height_block_transa ON public.stable_transactions USING btree (owner_address, height, block_transaction_index);


--
-- Name: idx_16512_stable_transactions_target_height_block_transaction_i; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_16512_stable_transactions_target_height_block_transaction_i ON public.stable_transactions USING btree (target, height, block_transaction_index);


--
-- Name: idx_16517_missing_transactions_height_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_16517_missing_transactions_height_idx ON public.missing_transactions USING btree (height);


--
-- Name: idx_16517_missing_transactions_height_transaction_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_16517_missing_transactions_height_transaction_id_idx ON public.missing_transactions USING btree (height, transaction_id);


--
-- Name: idx_16532_new_blocks_height_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_16532_new_blocks_height_idx ON public.new_blocks USING btree (height);


--
-- Name: idx_16537_new_transactions_height_indexed_at_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_16537_new_transactions_height_indexed_at_idx ON public.new_transactions USING btree (height, indexed_at);


--
-- Name: idx_16537_new_transactions_owner_address_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_16537_new_transactions_owner_address_id_idx ON public.new_transactions USING btree (owner_address, id);


--
-- Name: idx_16537_new_transactions_target_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_16537_new_transactions_target_id_idx ON public.new_transactions USING btree (target, id);


--
-- Name: idx_16542_new_block_transactions_height_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_16542_new_block_transactions_height_idx ON public.new_block_transactions USING btree (height);


--
-- Name: idx_16547_new_transaction_tags_height_indexed_at_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_16547_new_transaction_tags_height_indexed_at_idx ON public.new_transaction_tags USING btree (height, indexed_at);


--
-- Name: idx_16547_new_transaction_tags_transaction_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_16547_new_transaction_tags_transaction_id_idx ON public.new_transaction_tags USING btree (transaction_id);


--
-- Name: idx_16552_sqlite_autoindex_stable_blocks_1; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX idx_16552_sqlite_autoindex_stable_blocks_1 ON public.stable_blocks USING btree (indep_hash);


--
-- Name: idx_16552_stable_blocks_missing_tx_count_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_16552_stable_blocks_missing_tx_count_idx ON public.stable_blocks USING btree (missing_tx_count);


--
-- Name: idx_20402_stable_data_items_height_block_transaction_index_id_i; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_20402_stable_data_items_height_block_transaction_index_id_i ON public.stable_data_items USING btree (height, block_transaction_index, id);


--
-- Name: idx_20402_stable_data_items_owner_address_height_block_transact; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_20402_stable_data_items_owner_address_height_block_transact ON public.stable_data_items USING btree (owner_address, height, block_transaction_index, id);


--
-- Name: idx_20402_stable_data_items_parent_id_height_block_transaction_; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_20402_stable_data_items_parent_id_height_block_transaction_ ON public.stable_data_items USING btree (parent_id, height, block_transaction_index, id);


--
-- Name: idx_20402_stable_data_items_target_height_block_transaction_ind; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_20402_stable_data_items_target_height_block_transaction_ind ON public.stable_data_items USING btree (target, height, block_transaction_index, id);


--
-- Name: idx_20417_sqlite_autoindex_stable_data_item_tags_1; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX idx_20417_sqlite_autoindex_stable_data_item_tags_1 ON public.stable_data_item_tags USING btree (tag_name_hash, tag_value_hash, height, block_transaction_index, data_item_id, data_item_tag_index);


--
-- Name: idx_20417_stable_data_item_tags_data_item_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_20417_stable_data_item_tags_data_item_id_idx ON public.stable_data_item_tags USING btree (data_item_id);


--
-- Name: idx_20422_new_data_items_height_indexed_at_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_20422_new_data_items_height_indexed_at_idx ON public.new_data_items USING btree (height, indexed_at);


--
-- Name: idx_20422_new_data_items_owner_address_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_20422_new_data_items_owner_address_id_idx ON public.new_data_items USING btree (owner_address, id);


--
-- Name: idx_20422_new_data_items_parent_id_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_20422_new_data_items_parent_id_id_idx ON public.new_data_items USING btree (parent_id, id);


--
-- Name: idx_20422_new_data_items_root_transaction_id_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_20422_new_data_items_root_transaction_id_id_idx ON public.new_data_items USING btree (root_transaction_id, id);


--
-- Name: idx_20422_new_data_items_target_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_20422_new_data_items_target_id_idx ON public.new_data_items USING btree (target, id);


--
-- Name: idx_20427_new_data_item_tags_data_item_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_20427_new_data_item_tags_data_item_id_idx ON public.new_data_item_tags USING btree (data_item_id);


--
-- Name: idx_20427_new_data_item_tags_height_indexed_at_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_20427_new_data_item_tags_height_indexed_at_idx ON public.new_data_item_tags USING btree (height, indexed_at);


--
-- Name: idx_20432_bundle_data_items_filter_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_20432_bundle_data_items_filter_id_idx ON public.bundle_data_items USING btree (filter_id);


--
-- Name: idx_20432_bundle_data_items_parent_id_filter_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_20432_bundle_data_items_parent_id_filter_id_idx ON public.bundle_data_items USING btree (parent_id, filter_id);


--
-- Name: idx_20437_filters_filter_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_20437_filters_filter_idx ON public.filters USING btree (filter);


--
-- Name: idx_20437_sqlite_autoindex_filters_1; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX idx_20437_sqlite_autoindex_filters_1 ON public.filters USING btree (filter);


--
-- Name: idx_20442_bundles_format_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_20442_bundles_format_id_idx ON public.bundles USING btree (format_id);


--
-- Name: idx_20442_bundles_index_filter_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_20442_bundles_index_filter_id_idx ON public.bundles USING btree (index_filter_id);


--
-- Name: idx_20442_bundles_last_fully_indexed_at_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_20442_bundles_last_fully_indexed_at_idx ON public.bundles USING btree (last_fully_indexed_at);


--
-- Name: idx_20442_bundles_last_queued_at_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_20442_bundles_last_queued_at_idx ON public.bundles USING btree (last_queued_at);


--
-- Name: idx_20442_bundles_last_skipped_at_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_20442_bundles_last_skipped_at_idx ON public.bundles USING btree (last_skipped_at);


--
-- Name: idx_20442_bundles_matched_data_item_count_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_20442_bundles_matched_data_item_count_idx ON public.bundles USING btree (matched_data_item_count);


--
-- Name: idx_20442_bundles_unbundle_filter_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_20442_bundles_unbundle_filter_id_idx ON public.bundles USING btree (unbundle_filter_id);


--
-- Name: idx_29048_block_sources_name_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX idx_29048_block_sources_name_idx ON public.block_sources USING btree (name);


--
-- Name: idx_29053_blocked_ids_source_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_29053_blocked_ids_source_id_idx ON public.blocked_ids USING btree (block_source_id);


--
-- Name: idx_29058_blocked_hashes_source_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_29058_blocked_hashes_source_id_idx ON public.blocked_hashes USING btree (block_source_id);


--
-- Name: idx_29080_contiguous_data_ids_contiguous_data_hash_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_29080_contiguous_data_ids_contiguous_data_hash_idx ON public.contiguous_data_ids USING btree (contiguous_data_hash);


--
-- Name: idx_29086_data_roots_contiguous_data_hash_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_29086_data_roots_contiguous_data_hash_idx ON public.data_roots USING btree (contiguous_data_hash);


--
-- Name: new_blocks_index; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX new_blocks_index ON public.new_blocks USING btree (height);


--
-- Name: new_transaction_tags_index; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX new_transaction_tags_index ON public.new_transaction_tags USING btree (transaction_id, tag_name_hash, tag_value_hash);


--
-- Name: stable_blocks_index; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX stable_blocks_index ON public.stable_blocks USING btree (height);


--
-- Name: stable_transaction_tags_index; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX stable_transaction_tags_index ON public.stable_transaction_tags USING btree (transaction_id, tag_name_hash, tag_value_hash);


--
-- Name: tag_names_index; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX tag_names_index ON public.tag_names USING btree (hash, name);


--
-- Name: tag_values_index; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX tag_values_index ON public.tag_values USING btree (hash, value);


--
-- PostgreSQL database dump complete
--

