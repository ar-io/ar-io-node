{
  description = "AR.IO Node";

  outputs = { self, nixpkgs }:
    let pkgs = nixpkgs.legacyPackages.x86_64-linux;
    in {
      devShell.x86_64-linux = import ./shell.nix { inherit pkgs; };
    };
}
