\set ON_ERROR_STOP on
\getenv settleflow_database POSTGRES_DB
\getenv settleflow_app_password POSTGRES_APP_PASSWORD

SELECT format(
  'CREATE ROLE settleflow_app LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',
  :'settleflow_app_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'settleflow_app')
\gexec

ALTER ROLE "settleflow_app"
  WITH LOGIN PASSWORD :'settleflow_app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;

SELECT format('GRANT CONNECT ON DATABASE %I TO settleflow_app', :'settleflow_database')
\gexec

REVOKE CREATE ON SCHEMA "public" FROM "settleflow_app";
GRANT USAGE ON SCHEMA "public" TO "settleflow_app";
