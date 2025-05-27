{ pkgs, ... }:
{
  packages = with pkgs; [
    clickhouse
    duckdb
    gnumake
    graphviz
    nodePackages.typescript-language-server
    nodejs_20
    openjdk
    python311
    sqlite-interactive
    yaml-language-server
    yarn
  ];
}
