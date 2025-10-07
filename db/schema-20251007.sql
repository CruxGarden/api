--
-- PostgreSQL database dump
--

\restrict I4a1sp3PBNgW0LvGgZUvVlkhLtnhgHT8mbTYKLxy6BqchT7r1c8oQZReh7KcSaM

-- Dumped from database version 15.14
-- Dumped by pg_dump version 15.14 (Homebrew)

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
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.accounts (
    id uuid NOT NULL,
    email character varying(255) NOT NULL,
    role character varying(100) NOT NULL,
    created timestamp with time zone DEFAULT now() NOT NULL,
    updated timestamp with time zone DEFAULT now() NOT NULL,
    deleted timestamp with time zone,
    key character varying(255) NOT NULL
);


--
-- Name: authors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.authors (
    id uuid NOT NULL,
    key character varying(255) NOT NULL,
    account_id uuid NOT NULL,
    username character varying(100) NOT NULL,
    display_name character varying(255) NOT NULL,
    bio text,
    created timestamp with time zone DEFAULT now() NOT NULL,
    updated timestamp with time zone DEFAULT now() NOT NULL,
    deleted timestamp with time zone,
    home_id uuid
);


--
-- Name: cruxes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cruxes (
    id uuid NOT NULL,
    key character varying(255) NOT NULL,
    slug character varying(255) NOT NULL,
    title text,
    data text NOT NULL,
    type character varying(100) DEFAULT 'text'::character varying NOT NULL,
    theme_id uuid,
    author_id uuid NOT NULL,
    created timestamp with time zone DEFAULT now() NOT NULL,
    updated timestamp with time zone DEFAULT now() NOT NULL,
    deleted timestamp with time zone,
    status character varying(100) DEFAULT 'living'::character varying NOT NULL,
    visibility character varying(100) DEFAULT 'unlisted'::character varying NOT NULL,
    description text,
    meta jsonb
);


--
-- Name: dimensions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dimensions (
    id uuid NOT NULL,
    source_id uuid NOT NULL,
    target_id uuid NOT NULL,
    type character varying(255) NOT NULL,
    created timestamp with time zone DEFAULT now() NOT NULL,
    updated timestamp with time zone DEFAULT now() NOT NULL,
    deleted timestamp with time zone,
    weight integer,
    author_id uuid,
    note text,
    key character varying(255) NOT NULL,
    CONSTRAINT check_dimensions_no_self_reference CHECK ((source_id <> target_id))
);


--
-- Name: knex_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.knex_migrations (
    id integer NOT NULL,
    name character varying(255),
    batch integer,
    migration_time timestamp with time zone
);


--
-- Name: knex_migrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.knex_migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: knex_migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.knex_migrations_id_seq OWNED BY public.knex_migrations.id;


--
-- Name: knex_migrations_lock; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.knex_migrations_lock (
    index integer NOT NULL,
    is_locked integer
);


--
-- Name: knex_migrations_lock_index_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.knex_migrations_lock_index_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: knex_migrations_lock_index_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.knex_migrations_lock_index_seq OWNED BY public.knex_migrations_lock.index;


--
-- Name: markers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.markers (
    id uuid NOT NULL,
    path_id uuid NOT NULL,
    crux_id uuid NOT NULL,
    "order" integer NOT NULL,
    note text,
    author_id uuid NOT NULL,
    created timestamp with time zone DEFAULT now() NOT NULL,
    updated timestamp with time zone DEFAULT now() NOT NULL,
    deleted timestamp with time zone,
    key character varying(255) NOT NULL,
    CONSTRAINT check_order_positive CHECK (("order" >= 0))
);


--
-- Name: paths; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.paths (
    id uuid NOT NULL,
    key character varying(255) NOT NULL,
    slug character varying(255) NOT NULL,
    title text,
    description text,
    type character varying(100) DEFAULT 'living'::character varying NOT NULL,
    visibility character varying(100) DEFAULT 'unlisted'::character varying NOT NULL,
    author_id uuid NOT NULL,
    created timestamp with time zone DEFAULT now() NOT NULL,
    updated timestamp with time zone DEFAULT now() NOT NULL,
    deleted timestamp with time zone,
    kind character varying(100) NOT NULL,
    entry uuid NOT NULL,
    theme_id uuid
);


--
-- Name: tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tags (
    id uuid NOT NULL,
    label character varying(100) NOT NULL,
    created timestamp with time zone DEFAULT now() NOT NULL,
    updated timestamp with time zone DEFAULT now() NOT NULL,
    deleted timestamp with time zone,
    resource_type character varying(255) NOT NULL,
    resource_id uuid NOT NULL,
    author_id uuid,
    system boolean DEFAULT false NOT NULL,
    key character varying(255) NOT NULL
);


--
-- Name: themes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.themes (
    id uuid NOT NULL,
    title character varying(255) NOT NULL,
    key character varying(255) NOT NULL,
    description text,
    primary_color character varying(7) NOT NULL,
    secondary_color character varying(7) NOT NULL,
    tertiary_color character varying(7) NOT NULL,
    quaternary_color character varying(7) NOT NULL,
    created timestamp with time zone DEFAULT now() NOT NULL,
    updated timestamp with time zone DEFAULT now() NOT NULL,
    deleted timestamp with time zone,
    border_radius character varying(10),
    background_color character varying(255),
    panel_color character varying(255),
    text_color character varying(255),
    font character varying(100),
    mode character varying(100),
    author_id uuid
);


--
-- Name: knex_migrations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knex_migrations ALTER COLUMN id SET DEFAULT nextval('public.knex_migrations_id_seq'::regclass);


--
-- Name: knex_migrations_lock index; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knex_migrations_lock ALTER COLUMN index SET DEFAULT nextval('public.knex_migrations_lock_index_seq'::regclass);


--
-- Name: accounts accounts_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_email_key UNIQUE (email);


--
-- Name: accounts accounts_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_key_unique UNIQUE (key);


--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);


--
-- Name: authors authors_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authors
    ADD CONSTRAINT authors_key_unique UNIQUE (key);


--
-- Name: authors authors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authors
    ADD CONSTRAINT authors_pkey PRIMARY KEY (id);


--
-- Name: authors authors_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authors
    ADD CONSTRAINT authors_username_key UNIQUE (username);


--
-- Name: cruxes cruxes_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cruxes
    ADD CONSTRAINT cruxes_key_unique UNIQUE (key);


--
-- Name: cruxes cruxes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cruxes
    ADD CONSTRAINT cruxes_pkey PRIMARY KEY (id);


--
-- Name: cruxes cruxes_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cruxes
    ADD CONSTRAINT cruxes_slug_key UNIQUE (slug);


--
-- Name: dimensions dimensions_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dimensions
    ADD CONSTRAINT dimensions_key_unique UNIQUE (key);


--
-- Name: dimensions dimensions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dimensions
    ADD CONSTRAINT dimensions_pkey PRIMARY KEY (id);


--
-- Name: knex_migrations_lock knex_migrations_lock_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knex_migrations_lock
    ADD CONSTRAINT knex_migrations_lock_pkey PRIMARY KEY (index);


--
-- Name: knex_migrations knex_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knex_migrations
    ADD CONSTRAINT knex_migrations_pkey PRIMARY KEY (id);


--
-- Name: markers markers_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.markers
    ADD CONSTRAINT markers_key_unique UNIQUE (key);


--
-- Name: markers markers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.markers
    ADD CONSTRAINT markers_pkey PRIMARY KEY (id);


--
-- Name: paths paths_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.paths
    ADD CONSTRAINT paths_key_unique UNIQUE (key);


--
-- Name: paths paths_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.paths
    ADD CONSTRAINT paths_pkey PRIMARY KEY (id);


--
-- Name: paths paths_slug_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.paths
    ADD CONSTRAINT paths_slug_unique UNIQUE (slug);


--
-- Name: tags tags_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_key_unique UNIQUE (key);


--
-- Name: tags tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_pkey PRIMARY KEY (id);


--
-- Name: themes themes_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.themes
    ADD CONSTRAINT themes_key_unique UNIQUE (key);


--
-- Name: themes themes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.themes
    ADD CONSTRAINT themes_pkey PRIMARY KEY (id);


--
-- Name: themes themes_title_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.themes
    ADD CONSTRAINT themes_title_unique UNIQUE (title);


--
-- Name: markers unique_path_order; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.markers
    ADD CONSTRAINT unique_path_order UNIQUE (path_id, "order");


--
-- Name: tags unique_tag; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT unique_tag UNIQUE (resource_type, resource_id, label);


--
-- Name: dimensions_weight_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dimensions_weight_index ON public.dimensions USING btree (weight);


--
-- Name: idx_accounts_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_email ON public.accounts USING btree (email);


--
-- Name: idx_accounts_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_key ON public.accounts USING btree (key);


--
-- Name: idx_authors_account_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_authors_account_id ON public.authors USING btree (account_id);


--
-- Name: idx_authors_home_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_authors_home_id ON public.authors USING btree (home_id);


--
-- Name: idx_authors_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_authors_key ON public.authors USING btree (key);


--
-- Name: idx_authors_username; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_authors_username ON public.authors USING btree (username);


--
-- Name: idx_cruxes_author_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cruxes_author_id ON public.cruxes USING btree (author_id);


--
-- Name: idx_cruxes_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cruxes_created ON public.cruxes USING btree (created);


--
-- Name: idx_cruxes_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cruxes_key ON public.cruxes USING btree (key);


--
-- Name: idx_cruxes_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cruxes_slug ON public.cruxes USING btree (slug);


--
-- Name: idx_cruxes_visibility; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cruxes_visibility ON public.cruxes USING btree (visibility);


--
-- Name: idx_dimension_source_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dimension_source_type ON public.dimensions USING btree (source_id, type);


--
-- Name: idx_dimension_target_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dimension_target_type ON public.dimensions USING btree (target_id, type);


--
-- Name: idx_dimensions_author_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dimensions_author_id ON public.dimensions USING btree (author_id);


--
-- Name: idx_dimensions_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dimensions_key ON public.dimensions USING btree (key);


--
-- Name: idx_markers_author_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_markers_author_id ON public.markers USING btree (author_id);


--
-- Name: idx_markers_crux_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_markers_crux_id ON public.markers USING btree (crux_id);


--
-- Name: idx_markers_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_markers_key ON public.markers USING btree (key);


--
-- Name: idx_markers_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_markers_order ON public.markers USING btree ("order");


--
-- Name: idx_markers_path_crux; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_markers_path_crux ON public.markers USING btree (path_id, crux_id);


--
-- Name: idx_markers_path_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_markers_path_id ON public.markers USING btree (path_id);


--
-- Name: idx_markers_path_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_markers_path_order ON public.markers USING btree (path_id, "order");


--
-- Name: idx_paths_author_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_paths_author_id ON public.paths USING btree (author_id);


--
-- Name: idx_paths_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_paths_created ON public.paths USING btree (created);


--
-- Name: idx_paths_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_paths_key ON public.paths USING btree (key);


--
-- Name: idx_paths_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_paths_slug ON public.paths USING btree (slug);


--
-- Name: idx_paths_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_paths_type ON public.paths USING btree (type);


--
-- Name: idx_paths_visibility; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_paths_visibility ON public.paths USING btree (visibility);


--
-- Name: idx_tags_author_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tags_author_id ON public.tags USING btree (author_id);


--
-- Name: idx_tags_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tags_key ON public.tags USING btree (key);


--
-- Name: idx_tags_label; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tags_label ON public.tags USING btree (label);


--
-- Name: idx_tags_resource_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tags_resource_id ON public.tags USING btree (resource_id);


--
-- Name: idx_tags_resource_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tags_resource_type ON public.tags USING btree (resource_type);


--
-- Name: idx_tags_system; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tags_system ON public.tags USING btree (system);


--
-- Name: idx_themes_author_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_themes_author_id ON public.themes USING btree (author_id);


--
-- Name: idx_themes_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_themes_key ON public.themes USING btree (key);


--
-- Name: idx_themes_title; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_themes_title ON public.themes USING btree (title);


--
-- Name: authors authors_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authors
    ADD CONSTRAINT authors_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: authors authors_home_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authors
    ADD CONSTRAINT authors_home_id_foreign FOREIGN KEY (home_id) REFERENCES public.cruxes(id) ON DELETE SET NULL;


--
-- Name: cruxes cruxes_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cruxes
    ADD CONSTRAINT cruxes_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.authors(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: cruxes cruxes_theme_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cruxes
    ADD CONSTRAINT cruxes_theme_id_fkey FOREIGN KEY (theme_id) REFERENCES public.themes(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: dimensions dimensions_author_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dimensions
    ADD CONSTRAINT dimensions_author_id_foreign FOREIGN KEY (author_id) REFERENCES public.authors(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: dimensions dimensions_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dimensions
    ADD CONSTRAINT dimensions_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.cruxes(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: dimensions dimensions_target_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dimensions
    ADD CONSTRAINT dimensions_target_id_fkey FOREIGN KEY (target_id) REFERENCES public.cruxes(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: markers markers_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.markers
    ADD CONSTRAINT markers_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.authors(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: markers markers_crux_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.markers
    ADD CONSTRAINT markers_crux_id_fkey FOREIGN KEY (crux_id) REFERENCES public.cruxes(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: markers markers_path_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.markers
    ADD CONSTRAINT markers_path_id_fkey FOREIGN KEY (path_id) REFERENCES public.paths(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: paths paths_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.paths
    ADD CONSTRAINT paths_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.authors(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: paths paths_entry_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.paths
    ADD CONSTRAINT paths_entry_foreign FOREIGN KEY (entry) REFERENCES public.markers(id);


--
-- Name: paths paths_theme_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.paths
    ADD CONSTRAINT paths_theme_id_foreign FOREIGN KEY (theme_id) REFERENCES public.themes(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: tags tags_author_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_author_id_foreign FOREIGN KEY (author_id) REFERENCES public.authors(id) ON DELETE SET NULL;


--
-- Name: themes themes_author_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.themes
    ADD CONSTRAINT themes_author_id_foreign FOREIGN KEY (author_id) REFERENCES public.authors(id) ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--

\unrestrict I4a1sp3PBNgW0LvGgZUvVlkhLtnhgHT8mbTYKLxy6BqchT7r1c8oQZReh7KcSaM

