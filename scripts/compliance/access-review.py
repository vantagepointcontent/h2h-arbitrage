#!/usr/bin/env python3
"""
Quarterly access review script for H2H Arbitrage.
Enumerates GCP IAM bindings, K8s RBAC roles, and service accounts.
Produces CSV artifacts + a Markdown findings report.

Usage:
    python3 access-review.py --project h2h-arbitrage-prod --out-dir ./review

Requirements:
    - gcloud CLI authenticated with iam/viewer or broader
    - kubectl with current context set to production cluster
"""

import argparse
import csv
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List, Optional


class Colors:
    OK = "\033[92m"
    WARN = "\033[93m"
    FAIL = "\033[91m"
    RESET = "\033[0m"


def run_cmd(cmd: List[str], capture: bool = True) -> tuple[int, str, str]:
    """Run a shell command and return (exit_code, stdout, stderr)."""
    try:
        result = subprocess.run(
            cmd,
            capture_output=capture,
            text=True,
            timeout=120,
            check=False,
        )
        return result.returncode, result.stdout, result.stderr
    except FileNotFoundError:
        return 127, "", f"Command not found: {cmd[0]}"
    except subprocess.TimeoutExpired:
        return 124, "", "Command timed out"


def gcloud_available() -> bool:
    code, _, _ = run_cmd(["gcloud", "version"])
    return code == 0


def gcloud_authenticated(project: str) -> bool:
    code, _, _ = run_cmd(["gcloud", "projects", "describe", project])
    return code == 0


def kubectl_available() -> bool:
    code, _, _ = run_cmd(["kubectl", "version", "--client"])
    return code == 0


def kubectl_has_context() -> bool:
    code, _, _ = run_cmd(["kubectl", "get", "nodes"])
    return code == 0


def fetch_iam_bindings(project: str) -> List[dict]:
    """Fetch IAM policy bindings for a GCP project."""
    code, out, err = run_cmd(
        [
            "gcloud",
            "projects",
            "get-iam-policy",
            project,
            "--format=json",
        ]
    )
    if code != 0:
        print(f"{Colors.FAIL}ERROR fetching IAM policy: {err}{Colors.RESET}")
        return []
    try:
        policy = json.loads(out)
    except json.JSONDecodeError:
        print(f"{Colors.FAIL}ERROR parsing IAM policy JSON{Colors.RESET}")
        return []

    rows = []
    for binding in policy.get("bindings", []):
        role = binding.get("role", "")
        for member in binding.get("members", []):
            rows.append({
                "project": project,
                "role": role,
                "member": member,
                "condition": json.dumps(binding.get("condition")) if binding.get("condition") else "",
            })
    return rows


def fetch_k8s_rbac() -> List[dict]:
    """Fetch Roles, ClusterRoles, and bindings from the current K8s context."""
    rows = []
    # ClusterRoleBindings
    code, out, _ = run_cmd(["kubectl", "get", "clusterrolebindings", "-o", "json"])
    if code == 0:
        try:
            data = json.loads(out)
            for item in data.get("items", []):
                role_ref = item.get("roleRef", {})
                for subj in item.get("subjects", []):
                    rows.append({
                        "namespace": subj.get("namespace", "cluster-wide"),
                        "kind": subj.get("kind", ""),
                        "name": subj.get("name", ""),
                        "role_kind": role_ref.get("kind", ""),
                        "role_name": role_ref.get("name", ""),
                        "binding_name": item["metadata"]["name"],
                    })
        except json.JSONDecodeError:
            pass

    # RoleBindings (all namespaces)
    code, out, _ = run_cmd(["kubectl", "get", "rolebindings", "--all-namespaces", "-o", "json"])
    if code == 0:
        try:
            data = json.loads(out)
            for item in data.get("items", []):
                role_ref = item.get("roleRef", {})
                ns = item["metadata"].get("namespace", "")
                for subj in item.get("subjects", []):
                    rows.append({
                        "namespace": ns,
                        "kind": subj.get("kind", ""),
                        "name": subj.get("name", ""),
                        "role_kind": role_ref.get("kind", ""),
                        "role_name": role_ref.get("name", ""),
                        "binding_name": item["metadata"]["name"],
                    })
        except json.JSONDecodeError:
            pass
    return rows


def fetch_service_accounts(project: str) -> List[dict]:
    """Fetch service accounts and key metadata."""
    rows = []
    code, out, _ = run_cmd(
        ["gcloud", "iam", "service-accounts", "list", "--project", project, "--format=json"]
    )
    if code != 0:
        return rows
    try:
        sas = json.loads(out)
    except json.JSONDecodeError:
        return rows

    for sa in sas:
        email = sa.get("email", "")
        display = sa.get("displayName", "")
        # Check for keys
        kcode, kout, _ = run_cmd(
            [
                "gcloud",
                "iam",
                "service-accounts",
                "keys",
                "list",
                "--iam-account",
                email,
                "--project",
                project,
                "--format=json",
            ]
        )
        key_count = 0
        oldest_key_days = None
        if kcode == 0:
            try:
                keys = json.loads(kout)
                key_count = len(keys)
                now = datetime.now(timezone.utc)
                for key in keys:
                    valid_after = key.get("validAfterTime", "")
                    if valid_after:
                        try:
                            dt = datetime.fromisoformat(valid_after.replace("Z", "+00:00"))
                            days = (now - dt).days
                            if oldest_key_days is None or days > oldest_key_days:
                                oldest_key_days = days
                        except ValueError:
                            pass
            except json.JSONDecodeError:
                pass

        rows.append({
            "project": project,
            "email": email,
            "display_name": display,
            "disabled": sa.get("disabled", False),
            "key_count": key_count,
            "oldest_key_days": oldest_key_days or 0,
        })
    return rows


def flag_findings(
    iam: List[dict], rbac: List[dict], sas: List[dict]
) -> List[dict]:
    """Return a list of findings with severity."""
    findings = []

    # IAM findings
    for row in iam:
        role = row["role"]
        member = row["member"]
        if role == "roles/owner" and not member.startswith("serviceAccount:"):
            findings.append({
                "category": "IAM",
                "severity": "HIGH",
                "resource": member,
                "detail": f"Project-level Owner role: {role}",
                "remediation": "Move to finer-grained role or break-glass group",
            })
        if role == "roles/editor":
            findings.append({
                "category": "IAM",
                "severity": "MEDIUM",
                "resource": member,
                "detail": f"Project-level Editor role: {role}",
                "remediation": "Replace with custom role or service-specific role",
            })
        if "allUsers" in member or "allAuthenticatedUsers" in member:
            findings.append({
                "category": "IAM",
                "severity": "CRITICAL",
                "resource": member,
                "detail": f"Public IAM binding: {member} → {role}",
                "remediation": "Remove public binding immediately",
            })

    # K8s findings
    for row in rbac:
        role_name = row["role_name"]
        name = row["name"]
        if role_name == "cluster-admin" and row["kind"] in ("User", "Group"):
            findings.append({
                "category": "K8s RBAC",
                "severity": "HIGH",
                "resource": f"{row['kind']}/{name}",
                "detail": f"cluster-admin binding via {row['binding_name']}",
                "remediation": "Use namespace-scoped RoleBinding instead",
            })
        if row["namespace"] == "default" and row["role_name"] != "":
            findings.append({
                "category": "K8s RBAC",
                "severity": "LOW",
                "resource": f"{row['kind']}/{name}",
                "detail": f"RBAC binding in default namespace: {row['binding_name']}",
                "remediation": "Move workload to dedicated namespace",
            })

    # Service account findings
    for row in sas:
        if row["disabled"]:
            continue
        if row["key_count"] > 2:
            findings.append({
                "category": "Service Account",
                "severity": "MEDIUM",
                "resource": row["email"],
                "detail": f"{row['key_count']} user-managed keys",
                "remediation": "Rotate and reduce keys; prefer workload identity",
            })
        if row["oldest_key_days"] and row["oldest_key_days"] > 90:
            findings.append({
                "category": "Service Account",
                "severity": "MEDIUM",
                "resource": row["email"],
                "detail": f"Oldest key is {row['oldest_key_days']} days old",
                "remediation": "Rotate key immediately",
            })

    return findings


def write_csv(path: Path, headers: List[str], rows: List[dict]) -> None:
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=headers)
        writer.writeheader()
        for row in rows:
            writer.writerow({h: row.get(h, "") for h in headers})


def write_report(out_dir: Path, findings: List[dict], iam_count: int, rbac_count: int, sa_count: int) -> None:
    report_path = out_dir / "report.md"
    now = datetime.now(timezone.utc).isoformat()
    lines = [
        "# Quarterly Access Review Report",
        "",
        f"**Generated**: {now}",
        f"**IAM bindings**: {iam_count}",
        f"**K8s RBAC bindings**: {rbac_count}",
        f"**Service accounts**: {sa_count}",
        f"**Findings**: {len(findings)}",
        "",
        "## Findings",
        "",
        "| Severity | Category | Resource | Detail | Remediation |",
        "|---|---|---|---|---|",
    ]
    for f in sorted(findings, key=lambda x: ("CRITICAL", "HIGH", "MEDIUM", "LOW").index(x["severity"])):
        lines.append(f"| {f['severity']} | {f['category']} | {f['resource']} | {f['detail']} | {f['remediation']} |")
    lines.append("")
    lines.append("## Sign-off")
    lines.append("")
    lines.append("- [ ] Security Lead reviewed")
    lines.append("- [ ] Engineering Manager reviewed")
    lines.append("- [ ] Remediations completed")
    lines.append("")
    report_path.write_text("\n".join(lines))
    print(f"{Colors.OK}Report written to {report_path}{Colors.RESET}")


def main() -> int:
    parser = argparse.ArgumentParser(description="H2H Arbitrage quarterly access review")
    parser.add_argument("--project", default=os.environ.get("GCP_PROJECT", "h2h-arbitrage-prod"))
    parser.add_argument("--out-dir", default="./access-review-output")
    parser.add_argument("--dry-run", action="store_true", help="Print commands without executing")
    args = parser.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"Access Review for project: {args.project}")
    print(f"Output directory: {out_dir.resolve()}")
    print("-" * 60)

    # Check prerequisites
    gcloud_ok = gcloud_available()
    gcloud_auth = gcloud_authenticated(args.project) if gcloud_ok else False
    kubectl_ok = kubectl_available()
    kubectl_ctx = kubectl_has_context() if kubectl_ok else False

    if not gcloud_ok:
        print(f"{Colors.WARN}WARNING: gcloud CLI not found. IAM / SA enumeration skipped.{Colors.RESET}")
    elif not gcloud_auth:
        print(f"{Colors.WARN}WARNING: gcloud not authenticated for project {args.project}. IAM / SA enumeration skipped.{Colors.RESET}")

    if not kubectl_ok:
        print(f"{Colors.WARN}WARNING: kubectl not found. K8s RBAC enumeration skipped.{Colors.RESET}")
    elif not kubectl_ctx:
        print(f"{Colors.WARN}WARNING: kubectl cannot reach cluster. K8s RBAC enumeration skipped.{Colors.RESET}")

    # IAM
    iam_rows: List[dict] = []
    if gcloud_ok and gcloud_auth and not args.dry_run:
        print("Fetching GCP IAM bindings...")
        iam_rows = fetch_iam_bindings(args.project)
        write_csv(
            out_dir / "iam_bindings.csv",
            ["project", "role", "member", "condition"],
            iam_rows,
        )
        print(f"  {len(iam_rows)} bindings written")
    elif args.dry_run:
        print("[DRY-RUN] Would fetch IAM bindings")
    else:
        # Write a template so the auditor sees the expected schema
        write_csv(out_dir / "iam_bindings.csv", ["project", "role", "member", "condition"], [])
        print("  0 bindings written (no auth)")

    # K8s RBAC
    rbac_rows: List[dict] = []
    if kubectl_ok and kubectl_ctx and not args.dry_run:
        print("Fetching K8s RBAC bindings...")
        rbac_rows = fetch_k8s_rbac()
        write_csv(
            out_dir / "k8s_rbac.csv",
            ["namespace", "kind", "name", "role_kind", "role_name", "binding_name"],
            rbac_rows,
        )
        print(f"  {len(rbac_rows)} bindings written")
    elif args.dry_run:
        print("[DRY-RUN] Would fetch K8s RBAC bindings")
    else:
        write_csv(out_dir / "k8s_rbac.csv", ["namespace", "kind", "name", "role_kind", "role_name", "binding_name"], [])
        print("  0 bindings written (no auth)")

    # Service Accounts
    sa_rows: List[dict] = []
    if gcloud_ok and gcloud_auth and not args.dry_run:
        print("Fetching service accounts...")
        sa_rows = fetch_service_accounts(args.project)
        write_csv(
            out_dir / "service_accounts.csv",
            ["project", "email", "display_name", "disabled", "key_count", "oldest_key_days"],
            sa_rows,
        )
        print(f"  {len(sa_rows)} service accounts written")
    elif args.dry_run:
        print("[DRY-RUN] Would fetch service accounts")
    else:
        write_csv(out_dir / "service_accounts.csv", ["project", "email", "display_name", "disabled", "key_count", "oldest_key_days"], [])
        print("  0 service accounts written (no auth)")

    # Findings
    findings = flag_findings(iam_rows, rbac_rows, sa_rows)
    write_report(out_dir, findings, len(iam_rows), len(rbac_rows), len(sa_rows))

    print("-" * 60)
    print(f"Review complete. Artifacts in: {out_dir.resolve()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
