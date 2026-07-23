#!/usr/bin/env python3
"""deploy.py — deterministic deployment path for the Connect blueprint.

The same deployment the coding-assistant skill (SKILL.md) performs, as a plain
Python CLI: interview -> order file -> values -> preflight -> render -> deploy
-> optional UK DID claim + knowledge-base population -> smoke test -> next
steps. No LLM involved; both paths produce the identical order file and run
the identical scripts, so a deployment is reproducible from either front door.

stdlib only — no pip dependencies.

Usage:
  scripts/deploy.py                       # interactive interview
  scripts/deploy.py --express -p myproj   # all defaults, minimal questions
  scripts/deploy.py --order-file .connect-skill-order.myproj.json
  scripts/deploy.py --order-file ... --synth-only   # stop after render+synth (CI)

Files:
  .connect-skill-order.<projectName>.json   order (user intent), repo/cwd root
  csp-<projectName>/.connect-skill-values.json  derived render values (generated)
  csp-<projectName>/                            rendered CDK project
                                            (csp- prefix = one .gitignore line
                                            covers all rendered output; AWS
                                            resource names use the bare
                                            projectName, unprefixed)
"""

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
SCRIPTS = SKILL_DIR / "scripts"
TEMPLATES = SKILL_DIR / "templates" / "cdk-app"

BOLD, GREEN, YELLOW, RED, NC = "\033[1m", "\033[0;32m", "\033[1;33m", "\033[0;31m", "\033[0m"


def info(msg): print(f"→ {msg}")
def ok(msg): print(f"{GREEN}✓ {msg}{NC}")
def warn(msg): print(f"{YELLOW}⚠ {msg}{NC}")
def die(msg, code=1):
    print(f"{RED}✗ {msg}{NC}", file=sys.stderr)
    sys.exit(code)


def run(cmd, cwd=None, env=None):
    """Run a command streaming output; die on failure."""
    info(" ".join(str(c) for c in cmd))
    result = subprocess.run(cmd, cwd=cwd, env=env)
    if result.returncode != 0:
        die(f"command failed (exit {result.returncode}): {cmd[0]}")


# --------------------------------------------------------------------------
# Interview (mirrors SKILL.md Phase 1 — same questions, same defaults)
# --------------------------------------------------------------------------

PROJECT_NAME_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")


def ask(prompt, default=None, validate=None, choices=None):
    """Prompt until valid. Empty input takes the default (when present)."""
    suffix = ""
    if choices:
        suffix = f" ({'/'.join(choices)})"
    if default is not None:
        suffix += f" [{default}]"
    while True:
        raw = input(f"{BOLD}{prompt}{suffix}: {NC}").strip()
        if not raw and default is not None:
            raw = str(default)
        if choices and raw not in choices:
            warn(f"choose one of: {', '.join(choices)}")
            continue
        if validate:
            err = validate(raw)
            if err:
                warn(err)
                continue
        return raw


def ask_bool(prompt, default=False):
    d = "Y/n" if default else "y/N"
    raw = input(f"{BOLD}{prompt} [{d}]: {NC}").strip().lower()
    if not raw:
        return default
    return raw in ("y", "yes", "true", "1")


def validate_project_name(v):
    if not PROJECT_NAME_RE.match(v):
        return "use lowercase letters, digits, and single hyphens (no leading/trailing hyphen)"
    if len(v) > 32:
        return "max 32 characters"
    return None


def interview(express=False, project_name=None):
    """Collect the order + orchestration prefs. Returns (order, prefs)."""
    print(f"\n{BOLD}=== Amazon Connect blueprint — deployment interview ==={NC}\n")

    # --- Starter: identity ---
    if not project_name:
        project_name = ask("Project name", validate=validate_project_name)
    else:
        err = validate_project_name(project_name)
        if err:
            die(f"invalid project name '{project_name}': {err}")
    order = {"projectName": project_name}
    prefs = {"claimUkDid": False, "kbContent": "skip", "kbContentPath": ""}

    if express:
        # Express: en/us-east-1/feminine, defaults everywhere, no add-ons,
        # UK DID claimed — mirrors the skill's express pace (every question's
        # default, and the reach default is "claim a UK number").
        prefs["claimUkDid"] = True
        info("Express mode: defaults for everything else "
             "(us-east-1, English, feminine voice, no add-ons, UK number claimed).")
        return order, prefs

    company = ask("Company name", default="My Company")
    order["companyName"] = company

    # --- Locale & region ---
    order["region"] = ask("Region", default="us-east-1",
                          choices=["us-east-1", "eu-central-1"])
    order["language"] = ask("Language", default="en", choices=["en", "de"])
    order["voiceGender"] = ask("Voice", default="feminine",
                               choices=["feminine", "masculine"])

    default_greeting = (
        f"Hallo, willkommen bei {company}. Wie kann ich Ihnen helfen?"
        if order["language"] == "de"
        else f"Hello, welcome to {company}. How can I assist you today?"
    )
    order["greeting"] = ask("Greeting the agent opens with", default=default_greeting)

    # --- Aperitif side: custom prompts (deterministic variant of the skill's
    # customize course: seed the editable files, pause for the user to edit;
    # render picks them up from the working dir) ---
    if ask_bool("Customize the AI agent's prompts (persona/instructions)?"):
        run([str(SCRIPTS / "init-prompts.sh"), str(SKILL_DIR), str(Path.cwd())])
        print(f"  Edit {Path.cwd()}/prompts/orchestration.md and/or self-service.md now.\n"
              "  Keep the required scaffolding (system: block, {{$.conversationHistory}},\n"
              "  <message> tag, {{$.contentExcerpt}}) — the render step validates it.")
        input(f"{BOLD}  Press Enter when done editing (or immediately to keep defaults): {NC}")

    # --- Sides: add-on capabilities ---
    print(f"\n{BOLD}Add-on capabilities{NC} (any combination):")
    order["transferEnabled"] = ask_bool("  Human transfer (escalate to a live-agent queue)?")
    order["toolEnabled"] = ask_bool("  Tool calling (sample SAP order API via MCP gateway)?")
    order["contextInjectionEnabled"] = ask_bool("  Pre-call context injection?")
    order["customerProfilesEnabled"] = ask_bool("  Customer Profiles (caller lookup)?", default=True)
    order["recordingEnabled"] = ask_bool("  Call recording (DTMF consent gate)?")
    order["dataLakeEnabled"] = ask_bool("  Analytics data lake?")
    order["contactEventsEnabled"] = ask_bool("  Contact-events logging (EventBridge)?")
    order["knowledgeBaseEnabled"] = ask_bool("  Knowledge base (Bedrock RAG)?")
    if order["knowledgeBaseEnabled"]:
        choice = ask("    KB content: (a) bundled sample, (b) own folder, (c) empty for now",
                     default="a", choices=["a", "b", "c"])
        prefs["kbContent"] = {"a": "sample", "b": "path", "c": "skip"}[choice]
        if prefs["kbContent"] == "path":
            prefs["kbContentPath"] = ask("    Path to your content folder/file",
                                         validate=lambda v: None if Path(v).exists() else "path not found")

    # --- Drinks: reach ---
    reach = ask("How will you reach the agent? (a) UK phone number, (b) web-call frontend, (c) manual",
                default="a", choices=["a", "b", "c"])
    prefs["claimUkDid"] = reach == "a"
    order["frontendEnabled"] = reach == "b"

    # --- Digestif: operational ---
    info("The Connect instance is RETAINED on stack destroy by default "
         "(retainConnectInstance in lib/config.ts — advanced toggle, not asked here).")
    order["encryptionEnabled"] = ask_bool(
        "Encrypt stored data with a customer-managed KMS key?", default=True)
    idc = ask_bool("Sign in via IAM Identity Center SSO instead of Connect-managed users?\n"
                   f"  {YELLOW}IRREVERSIBLE at instance creation — switching later means recreating the instance{NC}\n ")
    order["identityCenterEnabled"] = idc
    if idc:
        print(f"\n{YELLOW}Manual step required BEFORE deploy:{NC}\n"
              "  1. IAM Identity Center console → Applications → Add application\n"
              "  2. Download the SAML metadata file\n"
              f"  3. Save it as: {Path.cwd() / 'saml-metadata.xml'}\n"
              "Preflight will verify the file exists.\n")

    return order, prefs


def confirm_order(order, prefs):
    print(f"\n{BOLD}Your order:{NC}")
    print(json.dumps(order, indent=2))
    print(f"Reach: {'UK phone number' if prefs['claimUkDid'] else ('web-call frontend' if order.get('frontendEnabled') else 'manual')}"
          f" | KB content: {prefs['kbContent']}")
    account = subprocess.run(
        ["aws", "sts", "get-caller-identity", "--query", "Account", "--output", "text"],
        capture_output=True, text=True)
    if account.returncode == 0:
        print(f"Deploy to AWS account: {account.stdout.strip()} ({order.get('region', 'us-east-1')})")
    if not ask_bool("Place this order?", default=True):
        die("aborted by user", 0)


# --------------------------------------------------------------------------
# Orchestration (identical machinery to the skill: the scripts/ layer)
# --------------------------------------------------------------------------

def stack_output(outputs, stack_suffix, key):
    for stack, values in outputs.items():
        if stack.endswith(stack_suffix):
            v = values.get(key)
            if v:
                return v
    return None


def main():
    ap = argparse.ArgumentParser(description="Deterministic Connect blueprint deployment")
    ap.add_argument("--order-file", help="existing order JSON — skips the interview")
    ap.add_argument("--express", action="store_true", help="defaults for everything (needs -p)")
    ap.add_argument("-p", "--project-name", help="project name (with --express)")
    ap.add_argument("--claim-uk-did", action="store_true",
                    help="claim a UK phone number after deploy (with --order-file)")
    ap.add_argument("--kb-content", default=None,
                    help="knowledge-base content path, or 'sample' (with --order-file)")
    ap.add_argument("--synth-only", action="store_true",
                    help="stop after render + synth — no AWS resources created")
    ap.add_argument("--yes", action="store_true", help="skip the order confirmation")
    args = ap.parse_args()

    cwd = Path.cwd()

    # --- 1. Order: interview, or load an existing file -----------------------
    if args.order_file:
        order_path = Path(args.order_file)
        if not order_path.is_file():
            die(f"order file not found: {order_path}")
        order = json.loads(order_path.read_text())
        if "projectName" not in order:
            die("order file has no projectName")
        prefs = {
            "claimUkDid": args.claim_uk_did,
            "kbContent": ("sample" if args.kb_content == "sample"
                          else "path" if args.kb_content else "skip"),
            "kbContentPath": args.kb_content if args.kb_content and args.kb_content != "sample" else "",
        }
    else:
        order, prefs = interview(express=args.express, project_name=args.project_name)
        order_path = cwd / f".connect-skill-order.{order['projectName']}.json"
        if not args.yes:
            confirm_order(order, prefs)
        order_path.write_text(json.dumps(order, indent=2) + "\n")
        ok(f"Order written: {order_path}")

    project = order["projectName"]
    region = order.get("region", "us-east-1")
    # Folder prefix "csp-" (Connect Skill Project): generated output is
    # ignorable with a single csp-*/ gitignore entry. Resource names are
    # NOT prefixed — config.prefix stays the bare projectName.
    project_dir = cwd / f"csp-{project}"
    values_path = project_dir / ".connect-skill-values.json"

    # --- 2. Values (validated derivation) ------------------------------------
    run([str(SCRIPTS / "build-values.sh"), str(order_path), str(values_path)])

    # --- 3. Preflight (includes the Identity Center gate) --------------------
    run([str(SCRIPTS / "preflight.sh"), region, str(order_path)])

    # --- 4. Render ------------------------------------------------------------
    run([str(SCRIPTS / "render-templates.sh"), str(values_path), str(TEMPLATES), str(project_dir)])

    # --- 5. Build + synth ------------------------------------------------------
    npm = shutil.which("npm") or die("npm not found on PATH")
    # Overwrite (not merge-conflict with) any pre-existing region env vars —
    # dict(**os.environ, AWS_REGION=...) raises TypeError when AWS_REGION is
    # already set (always the case in CI, e.g. CodeBuild).
    env = {**__import__("os").environ,
           "AWS_REGION": region, "AWS_DEFAULT_REGION": region, "CDK_DEFAULT_REGION": region}
    if subprocess.run([npm, "ci", "--silent"], cwd=project_dir, env=env).returncode != 0:
        run([npm, "install", "--silent"], cwd=project_dir, env=env)
    run(["npx", "tsc", "--noEmit", "-p", "tsconfig.json"], cwd=project_dir, env=env)
    run(["npx", "cdk", "synth", "--quiet"], cwd=project_dir, env=env)
    if args.synth_only:
        ok("Synth complete (--synth-only) — no AWS resources created.")
        return

    # --- 6. Deploy -------------------------------------------------------------
    run(["npx", "cdk", "deploy", "--all", "--require-approval", "never",
         "--outputs-file", "cdk-outputs.json"], cwd=project_dir, env=env)
    outputs = json.loads((project_dir / "cdk-outputs.json").read_text())
    instance_id = stack_output(outputs, "-ConnectInstance", "InstanceId")
    flow_id = stack_output(outputs, "-ContactFlow", "ContactFlowId")
    assistant_id = stack_output(outputs, "-Wisdom", "AssistantId")
    agent_id = stack_output(outputs, "-Wisdom", "OrchestrationAgentId")

    # --- 7. Optional: UK DID ----------------------------------------------------
    if prefs["claimUkDid"] and instance_id and flow_id:
        run([str(SCRIPTS / "claim-uk-did.sh"), instance_id, flow_id, region])

    # --- 8. Optional: populate the knowledge base --------------------------------
    if order.get("knowledgeBaseEnabled") and prefs["kbContent"] != "skip":
        content = prefs["kbContentPath"] or str(SKILL_DIR / "sample-data")
        run([str(SCRIPTS / "sync-kb.sh"), str(project_dir), content, region])

    # --- 9. Smoke test ------------------------------------------------------------
    if all([instance_id, flow_id, assistant_id, agent_id]):
        run([str(SCRIPTS / "smoke-test.sh"), instance_id, flow_id,
             assistant_id, agent_id, region, str(project_dir)])
    else:
        warn("could not resolve all IDs from cdk-outputs.json — smoke test skipped")

    # --- 10. Next steps (manual/console-dependent) ---------------------------------
    print(f"\n{BOLD}=== Deployment complete — next steps ==={NC}")
    if order.get("frontendEnabled"):
        cloudfront_url = stack_output(outputs, "-WebcallWidget", "CloudFrontUrl") or "<see WebcallWidget stack outputs>"
        print(f"""
Web-call frontend (console steps required):
  Web-call site URL:  {cloudfront_url}
  1. Connect admin console → Communication widgets → create a widget for flow '{project}-nova-sonic'
     — under allowed domains, add the site URL above ({cloudfront_url})
  2. Copy the FULL <script> embed snippet into a file: {cwd}/widget-embed.txt
  3. Copy the widget's security key, then run:
       {SCRIPTS}/setup-widget.sh {project_dir} {cwd}/widget-embed.txt '<SECURITY_KEY>' {region}
  4. Create a sign-in + matching Customer Profile for a test user:
       {SCRIPTS}/setup-test-users.sh {project_dir} <user> <First> <Last> <email> <+E164> 0000100042 {region}
     (customer number 0000100042 ties the user to the seeded sample orders)
  5. Open {cloudfront_url} and sign in to place a call.""")
    if order.get("identityCenterEnabled"):
        print(f"""
Identity Center SSO (finish in the console — values from the stack outputs):
  Relay state:        {stack_output(outputs, '-ConnectInstance', 'SamlRelayStateUrl')}
  Role mapping pair:  {stack_output(outputs, '-ConnectInstance', 'SamlFederationRoleArn')},{stack_output(outputs, '-ConnectInstance', 'SamlProviderArn')}
  Then: attribute mappings, assign users, create matching Connect users.
  Full walkthrough: references/identity-center-sso.md""")
    if order.get("customerProfilesEnabled", True) and not order.get("frontendEnabled"):
        print(f"""
Customer Profiles: create a profile for a real caller (profile-only, no Cognito):
       {SCRIPTS}/setup-test-users.sh {project_dir} <user> <First> <Last> <email> <+E164> 0000100042 {region}
     (customer number 0000100042 ties the caller to the seeded sample orders)""")
    if not prefs["claimUkDid"] and not order.get("frontendEnabled"):
        print(f"""
Phone number (manual): Connect console → Phone numbers → Claim a number,
  then set its contact flow to '{project}-nova-sonic'.""")
    if order.get("knowledgeBaseEnabled") and prefs["kbContent"] == "skip":
        print(f"""
Knowledge base is EMPTY. Populate anytime:
       {SCRIPTS}/sync-kb.sh {project_dir} <content-path> {region}""")
    print(f"""
Agent prompts: edit {cwd}/prompts/*.md (seed them first with scripts/init-prompts.sh
if missing), then re-render + deploy with redeploy.sh below — prompt files in the
working dir survive re-renders and are the source of truth.
Update the deployed stacks (after editing files in {project_dir.name}/):
       cd {project_dir} && npx cdk deploy --all
Re-render from the skill templates (only after changes under templates/cdk-app/;
wipes and regenerates the project dir — your order/values files are preserved):
       {SCRIPTS}/redeploy.sh --all {project_dir}
Tear down:
       cd {project_dir} && npx cdk destroy --all
""")


if __name__ == "__main__":
    main()
