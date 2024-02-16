{
  description = "AR.IO Node";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let pkgs = (import nixpkgs { inherit system; });
      in {
        devShells = {
          default = pkgs.mkShell {
            name = "ar-io-node-shell";
            buildInputs = with pkgs; [
              babashka
              gnumake
              graphviz
              nodePackages.typescript-language-server
              nodejs
              openjdk
              plantuml
              sqlite-interactive
              yaml-language-server
              yarn
            ];
          };
        };
      });

  nixConfig.bash-prompt = "\\e[32m[ar-io-node-shell]$\\e[0m ";
}
