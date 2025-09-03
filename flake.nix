{
  description = "AR.IO Node";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-25.05";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
        python3WithPackages = pkgs.python311.withPackages (ps: with ps; [
          # PyIceberg and dependencies
          pyiceberg
          pyarrow
          duckdb
          sqlalchemy
        ]);
      in
      {
        devShells = {
          default = pkgs.mkShell {
            name = "ar-io-node-shell";
            buildInputs = with pkgs; [
              clickhouse
              duckdb
              gnumake
              graphviz
              mr
              nodePackages.typescript-language-server
              nodejs_20
              openjdk
              python3WithPackages
              sqlite-interactive
              yaml-language-server
              yarn
            ];
          };
        };
      }
    );

  nixConfig.bash-prompt = "\\e[32m[ar-io-node-shell]$\\e[0m ";
}
