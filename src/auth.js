import fs from "fs";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

const USERS_FILE = "./data/users.json";
const SECRET = process.env.JWT_SECRET;

if (!SECRET) {
  throw new Error("JWT_SECRET is missing");
}

function readUsers() {
  return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
}

function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

export async function register(email, password) {
  const users = readUsers();

  if (users.find(u => u.email === email)) {
    throw new Error("User already exists");
  }

  const hash = await bcrypt.hash(password, 10);
  const user = { id: Date.now(), email, password: hash };

  users.push(user);
  writeUsers(users);

  return { id: user.id, email: user.email };
}

export async function login(email, password) {
  const users = readUsers();
  const user = users.find(u => u.email === email);

  if (!user) throw new Error("User not found");

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) throw new Error("Wrong password");

  return jwt.sign({ id: user.id, email: user.email }, SECRET);
}

export function verify(token) {
  return jwt.verify(token, SECRET);
}
