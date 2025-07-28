# AWS AppConfig for Docker Compose

This guide explains how to manage the `.env` configuration used by
`docker-compose.yaml` with **AWS AppConfig**. The configuration schema
is provided in [openapi-env.yaml](./openapi-env.yaml) and can be used to
validate configuration values uploaded to AppConfig.

## Steps

1. Create an AWS AppConfig configuration profile that references the
   `openapi-env.yaml` schema. Set the content type to `application/openapi+yaml`.
2. Upload a JSON document containing the key/value pairs for your
   environment variables. Only variables defined in the schema are
   validated. Values not included fall back to defaults in
   `docker-compose.yaml`.
3. Deploy the configuration. Download the values during container start
   and write them to a `.env` file or pass them as environment variables.

The schema documents every supported variable so AppConfig can ensure
that your Docker Compose environment is well formed.
