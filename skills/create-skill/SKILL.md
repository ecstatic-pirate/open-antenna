---
name: create-skill
description: >
  Meta-skill: creates new SKILL.md files from natural language descriptions.
  Use when: "create a skill for X", "new skill that does Y", "I want to add a skill",
  "/create-skill", "antenna create-skill". The creator figures out how — the user
  only describes what they want.
allowed-tools: Read, Write, Bash, WebFetch
---

# Create Skill

Meta-skill that generates new SKILL.md files from natural language descriptions. Fully autonomous — the user describes WHAT they want, the skill figures out HOW.

---

## Process

### Step 1: Capture Intent

Ask the user what they want the skill to do. One clear question:
> "What should this skill do? Describe it in plain language — what goes in, what comes out."

Wait for the description. Do not assume or fill in blanks without asking.

### Step 2: Research How to Do It

For any external services, APIs, or data sources the skill will need:
- Discover what APIs or tools exist for this purpose
- Identify auth requirements (API keys, OAuth, etc.)
- Find the simplest path to the required data

### Step 3: Ask for Credentials

If auth is needed, ask for credentials clearly:
> "To do this, I'll need [a Slack API token / a Linear API key / etc.]. Here's how to get one: [link]. Paste it here and I'll store it in the config."

### Step 4: Draft the SKILL.md

Generate a complete SKILL.md following this structure:

```markdown
---
name: {skill-name}
description: >
  {What this skill does, when it triggers. Include trigger phrases.}
allowed-tools: {comma-separated list of tools needed}
---

# {Skill Name}

{One paragraph: what it does and why.}

---

## Triggers

{Trigger phrases and conditions.}

---

## Step 1: {First step}

{Clear instructions.}

## Step 2: {Second step}

...

## Output

{What the skill produces and where it goes.}

## Error Handling

| Failure | Action |
|---------|--------|
| ... | ... |
```

### Step 5: Test It

Run the skill once with sample input. Show the user the output.

### Step 6: Install It

Save to `skills/{skill-name}/SKILL.md`. Confirm it's available.

---

## Naming Conventions

- Skill name: lowercase, kebab-case (e.g., `slack-digest`, `linear-standup`)
- Trigger phrases: natural language + slash command (e.g., `/slack-digest`, "run slack digest")
- Output dir: always use `{output_dir}` from config, never hardcode paths

---

## What Makes a Good Skill

- **One job.** A skill that does one thing well beats one that does many things poorly.
- **Explicit inputs.** Document exactly what the user needs to provide.
- **Graceful failures.** Every step has an error case. The skill never silently fails.
- **Testable.** A single test run should confirm it works end-to-end.
