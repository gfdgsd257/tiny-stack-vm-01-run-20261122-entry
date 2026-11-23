// Tiny stack VM for make.fun's tiny-stack-vm-01-run-20261122 bounty: a faithful
// port of the kit's reference VM (program/generator/subject/vm.mjs) plus the
// driver answering every instance: /input/<id>/{program.bin, input.bin}
//   -> /output/<id>/{stdout.bin, exit.txt}
// Node 22 runs this file directly (erasable TypeScript only, no installs,
// no clock, no network: the same run always writes the same bytes).
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const enc = new TextEncoder();

/** Opcode specs: [immediate bytes, pops, pushes]. Absent means unknown opcode. */
const SPEC: Record<number, readonly [number, number, number]> = {
  0x00: [0, 0, 0], 0x01: [1, 0, 1], 0x02: [4, 0, 1], 0x03: [0, 1, 0],
  0x04: [0, 1, 2], 0x05: [0, 2, 2], 0x06: [0, 2, 3], 0x07: [0, 3, 3],
  0x10: [0, 2, 1], 0x11: [0, 2, 1], 0x12: [0, 2, 1], 0x13: [0, 2, 1],
  0x14: [0, 2, 1], 0x15: [0, 2, 1], 0x16: [0, 2, 1], 0x17: [0, 1, 1],
  0x18: [0, 2, 1], 0x19: [0, 2, 1], 0x1a: [0, 2, 1], 0x1b: [0, 1, 1],
  0x1c: [0, 2, 1], 0x1d: [0, 2, 1], 0x1e: [0, 2, 1], 0x20: [0, 2, 1],
  0x21: [0, 2, 1], 0x22: [0, 2, 1], 0x30: [2, 0, 0], 0x31: [2, 1, 0],
  0x32: [2, 1, 0], 0x33: [2, 0, 0], 0x34: [0, 0, 0], 0x40: [0, 1, 1],
  0x41: [0, 2, 0], 0x50: [0, 1, 0], 0x51: [0, 1, 0], 0x52: [0, 0, 1],
  0x53: [0, 1, 0],
};

/** Runs one program on its input bytes: the bytes it wrote and its exit code. */
function run(program: Uint8Array, input: Uint8Array): { out: Uint8Array; exit: number } {
  const n = program.length;
  const D = new Int32Array(256); // data stack
  let sp = 0;
  const C = new Int32Array(64); // call stack
  let csp = 0;
  const M = new Int32Array(256); // memory, all zero
  const out = new Uint8Array(65536);
  let olen = 0;
  let inPos = 0;
  let pc = 0;
  let steps = 0;
  // A trap ends the program at once: its code is the exit code, and the
  // output written before it is kept.
  const done = (exit: number) => ({ out: out.slice(0, olen), exit });

  for (;;) {
    if (steps === 1000000) return done(10); // step limit
    if (pc < 0 || pc >= n) return done(9); // pc outside the program
    const op = program[pc];
    const spec = SPEC[op];
    if (spec === undefined) return done(5); // unknown opcode
    const imm = spec[0];
    if (pc + imm >= n) return done(9); // immediate cut off by the end
    steps++;
    const next = pc + 1 + imm;
    if (sp < spec[1]) return done(2); // stack underflow
    if (sp - spec[1] + spec[2] > 256) return done(3); // stack overflow
    pc = next;
    switch (op) {
      case 0x00: return done(0); // HALT
      case 0x01: D[sp++] = (program[next - 1] << 24) >> 24; break; // PUSH8, sign-extended
      case 0x02: // PUSH32, little-endian signed
        D[sp++] = program[next - 4] | (program[next - 3] << 8) | (program[next - 2] << 16) | (program[next - 1] << 24);
        break;
      case 0x03: sp--; break; // POP
      case 0x04: D[sp] = D[sp - 1]; sp++; break; // DUP
      case 0x05: { const t = D[sp - 1]; D[sp - 1] = D[sp - 2]; D[sp - 2] = t; break; } // SWAP
      case 0x06: D[sp] = D[sp - 2]; sp++; break; // OVER
      case 0x07: { const a = D[sp - 3]; D[sp - 3] = D[sp - 2]; D[sp - 2] = D[sp - 1]; D[sp - 1] = a; break; } // ROT
      case 0x17: D[sp - 1] = -D[sp - 1] | 0; break; // NEG, wraps
      case 0x1b: D[sp - 1] = ~D[sp - 1]; break; // NOT
      case 0x30: // JMP
      case 0x31: // JZ
      case 0x32: { // JNZ
        const rel = ((program[next - 2] | (program[next - 1] << 8)) << 16) >> 16;
        let take = true;
        if (op !== 0x30) { const v = D[--sp]; take = op === 0x31 ? v === 0 : v !== 0; }
        if (take) pc = next + rel;
        break;
      }
      case 0x33: // CALL
        if (csp === 64) return done(7);
        C[csp++] = next;
        pc = program[next - 2] | (program[next - 1] << 8);
        break;
      case 0x34: // RET
        if (csp === 0) return done(8);
        pc = C[--csp];
        break;
      case 0x40: { // LOAD
        const addr = D[sp - 1];
        if (addr < 0 || addr >= 256) return done(6);
        D[sp - 1] = M[addr];
        break;
      }
      case 0x41: { // STORE
        const addr = D[sp - 1];
        const v = D[sp - 2];
        if (addr < 0 || addr >= 256) return done(6);
        sp -= 2;
        M[addr] = v;
        break;
      }
      case 0x50: { // PRINT, decimal ASCII, no newline
        const bytes = enc.encode(String(D[sp - 1]));
        if (olen + bytes.length > 65536) return done(11);
        sp--;
        out.set(bytes, olen);
        olen += bytes.length;
        break;
      }
      case 0x51: // PUTC, one byte
        if (olen + 1 > 65536) return done(11);
        out[olen++] = D[--sp] & 255;
        break;
      case 0x52: D[sp++] = inPos < input.length ? input[inPos++] : -1; break; // IN
      case 0x53: return done(D[--sp] & 255); // EXIT, low byte
      default: { // two-operand arithmetic, logic and comparison
        const b = D[sp - 1];
        const a = D[sp - 2];
        let r: number;
        switch (op) {
          case 0x10: r = (a + b) | 0; break; // ADD, wraps
          case 0x11: r = (a - b) | 0; break; // SUB, wraps
          case 0x12: r = Math.imul(a, b); break; // MUL, low 32 bits
          case 0x13: // DIV, truncated toward zero
            if (b === 0) return done(4);
            r = a === -2147483648 && b === -1 ? a : (a / b) | 0;
            break;
          case 0x14: // MOD, sign of a
            if (b === 0) return done(4);
            r = b === -1 ? 0 : (a % b) | 0;
            break;
          case 0x15: // DIVU, unsigned
            if (b === 0) return done(4);
            r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
            break;
          case 0x16: // MODU, unsigned
            if (b === 0) return done(4);
            r = ((a >>> 0) % (b >>> 0)) | 0;
            break;
          case 0x18: r = a & b; break; // AND
          case 0x19: r = a | b; break; // OR
          case 0x1a: r = a ^ b; break; // XOR
          case 0x1c: r = a << (b & 31); break; // SHL
          case 0x1d: r = a >> (b & 31); break; // SHR, arithmetic
          case 0x1e: r = (a >>> (b & 31)) | 0; break; // SHRU, logical
          case 0x20: r = a === b ? 1 : 0; break; // EQ
          case 0x21: r = a < b ? 1 : 0; break; // LT, signed
          default: r = (a >>> 0) < (b >>> 0) ? 1 : 0; // 0x22 LTU, unsigned
        }
        sp -= 2;
        D[sp++] = r;
      }
    }
  }
}

// Driver: answer every instance of the set in one run.
const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const program = new Uint8Array(readFileSync(join(I, id, 'program.bin')));
  const input = new Uint8Array(readFileSync(join(I, id, 'input.bin')));
  const { out, exit } = run(program, input);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'stdout.bin'), out);
  writeFileSync(join(O, id, 'exit.txt'), String(exit) + '\n');
}
