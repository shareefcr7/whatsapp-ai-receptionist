// Creates a staff login, or with --reset changes an existing password. Prompts, so the password stays out of shell history and process lists.
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { hashPassword } from '../services/auth/index.ts';
import { passwordProblem } from '../types/api.ts';
import { closePool, query } from './pool.ts';

// Mirrors the CHECK constraint on staff_users.role.
export const ROLES = ['admin', 'agent'] as const;
export type Role = (typeof ROLES)[number];

/** Blank means the default, admin. Anything else must match exactly: never guess at a role. */
export function parseRole(answer: string): Role | null {
  const role = answer.trim();
  if (role === '') return 'admin';
  return ROLES.find((r) => r === role) ?? null;
}

export async function emailExists(email: string): Promise<boolean> {
  return (await query('SELECT 1 FROM staff_users WHERE lower(email) = lower($1)', [email])).length > 0;
}

/** Returns false if the email is taken. The unique index decides, so two simultaneous runs cannot both succeed. */
export async function createStaffAccount(input: { email: string; fullName: string; role: Role; password: string }): Promise<boolean> {
  const passwordHash = await hashPassword(input.password);
  const rows = await query(
    `INSERT INTO staff_users (email, full_name, role, password_hash) VALUES ($1, $2, $3, $4)
     ON CONFLICT (lower(email)) DO NOTHING RETURNING id`,
    [input.email, input.fullName, input.role, passwordHash],
  );
  return rows.length > 0;
}

/** Returns false if there is no such account. Signs the person out everywhere. */
export async function resetStaffPassword(email: string, password: string): Promise<boolean> {
  const passwordHash = await hashPassword(password);
  const [staff] = await query<{ id: string }>('UPDATE staff_users SET password_hash = $2 WHERE lower(email) = lower($1) RETURNING id', [email, passwordHash]);
  if (!staff) return false;
  await query('DELETE FROM staff_sessions WHERE staff_id = $1', [staff.id]);
  return true;
}

async function main(resetting: boolean) {
  if (!process.stdin.isTTY) throw new Error('This command needs an interactive terminal, so the password can be typed hidden.');

  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) process.stdout.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });

  // Ctrl-C and Ctrl-D would otherwise leave a prompt waiting forever.
  let finished = false;
  const cancel = () => {
    if (finished) return;
    console.log('\nCancelled. Nothing was saved.');
    process.exit(130);
  };
  rl.on('SIGINT', cancel);
  rl.on('close', cancel);

  const askHidden = async (prompt: string) => {
    process.stdout.write(prompt);
    muted = true;
    const answer = await rl.question('');
    muted = false;
    process.stdout.write('\n');
    return answer;
  };

  const askEmail = async () => {
    for (;;) {
      const email = (await rl.question('Email: ')).trim().toLowerCase();
      if (!z.email().safeParse(email).success) console.log('That is not a valid email address. Try again.');
      else if (resetting && !(await emailExists(email))) console.log('No account uses that email. Try again.');
      else if (!resetting && (await emailExists(email))) {
        console.log('An account with that email already exists. Use another email, or change its password with: npm run staff:reset-password');
      } else return email;
    }
  };

  const askFullName = async () => {
    for (;;) {
      const fullName = (await rl.question('Full name: ')).trim();
      if (fullName && fullName.length <= 200) return fullName;
      console.log('Enter a name of up to 200 characters.');
    }
  };

  const askRole = async () => {
    for (;;) {
      const role = parseRole(await rl.question('Choose admin or agent. Role [admin]: '));
      if (role) return role;
      console.log('That role does not exist. Choose admin or agent.');
    }
  };

  const askPassword = async (context: string[]) => {
    for (;;) {
      const password = await askHidden('Password (12+ characters, hidden): ');
      const problem = passwordProblem(password, context);
      if (problem) console.log(`${problem} Try again.`);
      else if ((await askHidden('Repeat password: ')) !== password) console.log('The passwords do not match. Try again.');
      else return password;
    }
  };

  try {
    const email = await askEmail();
    if (resetting) {
      const password = await askPassword([email]);
      if (!(await resetStaffPassword(email, password))) throw new Error('That account no longer exists. Nothing was saved.');
      console.log(`Password changed for ${email}. Its existing sessions have been signed out.`);
      return;
    }
    const fullName = await askFullName();
    const role = await askRole();
    console.log(`Using role: ${role}.`);
    const password = await askPassword([email, fullName]);
    if (!(await createStaffAccount({ email, fullName, role, password }))) throw new Error('An account with that email was just created. Nothing was saved.');
    console.log(`Created ${role} account for ${email}.`);
  } finally {
    finished = true;
    rl.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.includes('--reset'));
  } catch (err) {
    // Connection failures can arrive with an empty message.
    console.error((err as Error).message || 'Could not reach the database. Check DATABASE_URL and that PostgreSQL is running.');
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
