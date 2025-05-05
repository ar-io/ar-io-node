Feature: ArNS

Scenario: resolving an ArNS name
  Given docker compose is running
  When I attempt to resolve 'ardrive.ar-io.localhost'
  Then I should receive an HTTP 200

