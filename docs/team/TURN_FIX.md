# Directional movement follow-up

The left/right arrows now turn the walking body and camera toward travel in both views. Previously first person always strafed, and a short third-person tap could stop the body rotation before reaching the intended heading.

The controller retains the intended heading after release, starts rotation on the first frame, and eases acceleration according to body alignment. Held movement uses a stable basis so automatic camera rotation does not bend the path. Deliberate mouse look still steers movement, and switching views while holding an arrow preserves travel direction. Vehicle steering and head look remain separate.

Validation: 162 tests pass, including 25 camera tests covering left/right walking and running in both views, one-frame taps at a wall, mouse steering, camera switching, collision, orbit, modal input and frame-rate consistency. Typecheck and production build pass. Development graphics review visibly reaches matching body/view headings of -90° and +90° after short taps; no console errors were reported. The rebuilt macOS app opens its existing isolated local QA city with zero active workers. Native keyboard verification was interrupted by user interaction; browser scene checks and controller regressions provide the turn evidence.

Updated macOS and Windows ZIPs are in the main checkout's ignored `artifacts/` directory with `turn-fix` filenames and SHA256 sidecars. Both archives pass integrity checks; Windows native binaries pass the target checks, but Windows execution remains untested. Android/iOS companion sources are unchanged. The port-4610 runtime, Pixel worker and saved city were not replaced. The updated macOS QA app is left open, and the development preview remains available on port 4618.
