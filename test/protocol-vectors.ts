// Shared device-to-host vectors. The parent PROTOCOL.md points Firmware authors here.
export const accepted = [
  "KEY 1 1 DOWN", "KEY 1 12 UP", "KEY 18446744073709551615 9 DOWN",
  "ENC 1 1", "ENC 1 -1", "ENC 1 32", "ENC 1 -32", "PONG 0", "PONG 4294967295",
];
export const rejected = [
  "KEY 0 1 DOWN", "KEY 18446744073709551616 1 UP", "KEY 1 0 DOWN", "KEY 1 13 UP",
  "KEY 1 01 DOWN", "KEY 01 1 DOWN", "KEY 1 1 down", "KEY 1 1 DOWN extra",
  " KEY 1 1 DOWN", "KEY 1 1 DOWN ", "KEY 1  1 DOWN", "KEY\t1\t1\tDOWN",
  "ENC 1 0", "ENC 1 -0", "ENC 1 +1", "ENC 1 01", "ENC 1 33", "ENC 1 -33",
  "ENC 1 CW", "ESC 1 DOWN", "APPROVE 1 DOWN", "JOY 1 LEFT",
  "PONG -1", "PONG 01", "PONG 4294967296", "UNKNOWN 1",
];
