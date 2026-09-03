#!/usr/bin/env python3
"""
FastMCP GTM Server - 올바른 @mcp.tool() 데코레이터 방식
"""
import json
import logging
import sys
import os
from typing import Any, Dict, List, Optional

# Redirect logging to stderr
logging.basicConfig(
    level=logging.INFO,
    stream=sys.stderr,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger("gtm-fastmcp-server")

from mcp.server import FastMCP

# Initialize the MCP server
mcp = FastMCP("gtm-fastmcp-server")

# GTM client initialization
gtm_client = None

def get_gtm_client():
    """Lazy initialization of GTM client"""
    global gtm_client
    if gtm_client is None:
        try:
            from gtm_client_fixed import GTMClient
            credentials_file = os.getenv('GTM_CREDENTIALS_FILE', 'credentials.json')
            token_file = os.getenv('GTM_TOKEN_FILE', 'token.json')
            gtm_client = GTMClient(credentials_file, token_file)
            logger.info("GTM client initialized successfully")
        except Exception as e:
            logger.error(f"Failed to initialize GTM client: {e}")
            raise Exception(f"GTM authentication failed: {e}. Please ensure credentials.json is properly configured.")
    return gtm_client

# Load GTM components
try:
    from gtm_components import GTMComponentTemplates, GTMWorkflowBuilder
    HAS_GTM_COMPONENTS = True
    logger.info("GTM components loaded successfully")
except ImportError as e:
    logger.error(f"Failed to load GTM components: {e}")
    HAS_GTM_COMPONENTS = False

def _account_ids(client, account_id: str) -> list:
    raw = (account_id or "").strip()
    if raw.lower() in ("all", "*", "list"):
        env_ids = os.getenv("GTM_ACCOUNT_IDS", "")
        ids = [x.strip() for x in env_ids.split(",") if x.strip()]
        if ids:
            return ids
        return [str(a.get("accountId")) for a in client.list_accounts() if a.get("accountId")]
    return [raw]


def _summarize_tag(tag: dict) -> dict:
    return {
        "name": tag.get("name"),
        "type": tag.get("type"),
        "tagId": tag.get("tagId"),
        "paused": tag.get("paused", False),
        "firingTriggerId": tag.get("firingTriggerId", []),
    }


@mcp.tool()
def test_gtm_connection(account_id: str) -> dict:
    """Test GTM API connection. Pass account_id 'all' to list every configured account."""
    try:
        client = get_gtm_client()
        if (account_id or "").strip().lower() in ("all", "*", "list"):
            accounts = client.list_accounts()
            env_ids = [x.strip() for x in os.getenv("GTM_ACCOUNT_IDS", "").split(",") if x.strip()]
            return {
                "status": "success",
                "message": "GTM API connection successful",
                "oauth_accounts": [
                    {
                        "accountId": a.get("accountId"),
                        "name": a.get("name"),
                        "path": a.get("path"),
                    }
                    for a in accounts
                ],
                "configured_account_ids": env_ids,
            }
        containers = client.list_containers(account_id)
        return {
            "status": "success",
            "message": "GTM API connection successful",
            "account_id": account_id,
            "containers_found": len(containers),
            "containers": [{"name": c.get("name", "Unknown"), "containerId": c.get("containerId", "Unknown"), "publicId": c.get("publicId")} for c in containers[:5]]
        }
    except Exception as e:
        return {
            "status": "error",
            "message": f"GTM connection failed: {str(e)}"
        }

@mcp.tool()
def list_gtm_accounts(query: str = "") -> dict:
    """List GTM accounts visible to the authorized user"""
    try:
        client = get_gtm_client()
        accounts = client.list_accounts()
        if query:
            q = query.lower()
            accounts = [
                a for a in accounts
                if q in str(a.get("name", "")).lower() or q in str(a.get("accountId", ""))
            ]
        return {
            "status": "success",
            "total_accounts": len(accounts),
            "accounts": [
                {
                    "accountId": a.get("accountId"),
                    "name": a.get("name"),
                    "path": a.get("path"),
                }
                for a in accounts
            ],
        }
    except Exception as e:
        return {
            "status": "error",
            "message": f"Failed to list accounts: {str(e)}"
        }

def _container_inventory(client, account_id: str, container: dict) -> dict:
    container_id = str(container.get("containerId"))
    inventory = {
        "name": container.get("name"),
        "containerId": container_id,
        "publicId": container.get("publicId"),
        "path": container.get("path"),
        "tagManagerUrl": container.get("tagManagerUrl"),
        "usageContext": container.get("usageContext"),
    }
    try:
        workspaces = client.list_workspaces(account_id, container_id)
        inventory["workspaces"] = [
            {"workspaceId": w.get("workspaceId"), "name": w.get("name")}
            for w in workspaces
        ]
        chosen = next(
            (w for w in workspaces if w.get("name") == "Default Workspace"),
            workspaces[0] if workspaces else None,
        )
        if chosen:
            ws_id = str(chosen.get("workspaceId"))
            inventory["workspace"] = {
                "workspaceId": ws_id,
                "name": chosen.get("name"),
            }
            inventory["workspace_tags"] = [
                _summarize_tag(t) for t in client.list_tags(account_id, container_id, ws_id)
            ]
    except Exception as e:
        inventory["workspace_error"] = str(e)
    try:
        live = client.get_live_version(account_id, container_id)
        live_tags = live.get("tag", []) if live else []
        inventory["live_version"] = {
            "name": live.get("name") or live.get("containerVersionId"),
            "containerVersionId": live.get("containerVersionId"),
            "description": live.get("description"),
        }
        inventory["live_tags"] = [_summarize_tag(t) for t in live_tags]
    except Exception as e:
        inventory["live_error"] = str(e)
    return inventory

@mcp.tool()
def list_gtm_containers(account_id: str) -> dict:
    """List GTM containers (and tags). Pass account_id 'all' to cover GTM_ACCOUNT_IDS."""
    try:
        client = get_gtm_client()
        ids = _account_ids(client, account_id)
        inventories = []
        for aid in ids:
            containers = client.list_containers(aid)
            inventories.append({
                "account_id": aid,
                "total_containers": len(containers),
                "containers": [
                    _container_inventory(client, aid, c) for c in containers
                ],
            })
        if len(inventories) == 1:
            return {
                "status": "success",
                **inventories[0],
            }
        return {
            "status": "success",
            "account_id": "all",
            "accounts": inventories,
        }
    except Exception as e:
        return {
            "status": "error",
            "message": f"Failed to list containers: {str(e)}"
        }

@mcp.tool()
def list_gtm_tags(account_id: str, container_id: str, workspace_id: str = "") -> dict:
    """List tags in a container (workspace draft + live published version)"""
    try:
        client = get_gtm_client()
        workspaces = client.list_workspaces(account_id, container_id)
        chosen_workspace = None
        if workspace_id:
            chosen_workspace = next(
                (w for w in workspaces if str(w.get("workspaceId")) == str(workspace_id)),
                None,
            )
            if chosen_workspace is None:
                chosen_workspace = {"workspaceId": workspace_id, "name": "(provided)"}
        else:
            chosen_workspace = next(
                (w for w in workspaces if w.get("name") == "Default Workspace"),
                workspaces[0] if workspaces else None,
            )
        if chosen_workspace is None:
            return {
                "status": "error",
                "message": f"No workspace found for container {container_id}",
                "workspaces": workspaces,
            }

        ws_id = str(chosen_workspace.get("workspaceId"))
        workspace_tags = client.list_tags(account_id, container_id, ws_id)

        live = {}
        live_error = None
        try:
            live = client.get_live_version(account_id, container_id)
        except Exception as e:
            live_error = str(e)

        live_tags = live.get("tag", []) if live else []
        return {
            "status": "success",
            "account_id": account_id,
            "container_id": container_id,
            "workspaces": [
                {"workspaceId": w.get("workspaceId"), "name": w.get("name")}
                for w in workspaces
            ],
            "workspace": {
                "workspaceId": ws_id,
                "name": chosen_workspace.get("name"),
            },
            "workspace_tag_count": len(workspace_tags),
            "workspace_tags": [_summarize_tag(t) for t in workspace_tags],
            "live_version": {
                "name": live.get("name") or live.get("containerVersionId"),
                "containerVersionId": live.get("containerVersionId"),
                "description": live.get("description"),
                "tag_count": len(live_tags),
                "error": live_error,
            },
            "live_tags": [_summarize_tag(t) for t in live_tags],
        }
    except Exception as e:
        return {
            "status": "error",
            "message": f"Failed to list tags: {str(e)}"
        }

def _summarize_trigger(trigger: dict) -> dict:
    return {
        "name": trigger.get("name"),
        "type": trigger.get("type"),
        "triggerId": trigger.get("triggerId"),
    }


def _summarize_variable(variable: dict) -> dict:
    return {
        "name": variable.get("name"),
        "type": variable.get("type"),
        "variableId": variable.get("variableId"),
    }


def _choose_workspace(client, account_id: str, container_id: str, workspace_id: str = "") -> dict:
    workspaces = client.list_workspaces(account_id, container_id)
    if workspace_id:
        chosen = next(
            (w for w in workspaces if str(w.get("workspaceId")) == str(workspace_id)),
            {"workspaceId": workspace_id, "name": "(provided)"},
        )
        return chosen, workspaces
    chosen = next(
        (w for w in workspaces if w.get("name") == "Default Workspace"),
        workspaces[0] if workspaces else None,
    )
    return chosen, workspaces


@mcp.tool()
def list_gtm_triggers(account_id: str, container_id: str, workspace_id: str = "") -> dict:
    """List triggers in a container (workspace draft + live published version)."""
    try:
        client = get_gtm_client()
        chosen, workspaces = _choose_workspace(client, account_id, container_id, workspace_id)
        if chosen is None:
            return {
                "status": "error",
                "message": f"No workspace found for container {container_id}",
                "workspaces": workspaces,
            }
        ws_id = str(chosen.get("workspaceId"))
        workspace_triggers = client.list_triggers(account_id, container_id, ws_id)
        live = {}
        live_error = None
        try:
            live = client.get_live_version(account_id, container_id)
        except Exception as e:
            live_error = str(e)
        live_triggers = live.get("trigger", []) if live else []
        return {
            "status": "success",
            "account_id": account_id,
            "container_id": container_id,
            "workspaces": [
                {"workspaceId": w.get("workspaceId"), "name": w.get("name")}
                for w in workspaces
            ],
            "workspace": {"workspaceId": ws_id, "name": chosen.get("name")},
            "workspace_trigger_count": len(workspace_triggers),
            "workspace_triggers": [_summarize_trigger(t) for t in workspace_triggers],
            "live_version": {
                "name": live.get("name") or live.get("containerVersionId"),
                "containerVersionId": live.get("containerVersionId"),
                "error": live_error,
            },
            "live_triggers": [_summarize_trigger(t) for t in live_triggers],
        }
    except Exception as e:
        return {"status": "error", "message": f"Failed to list triggers: {str(e)}"}


@mcp.tool()
def list_gtm_variables(account_id: str, container_id: str, workspace_id: str = "") -> dict:
    """List custom variables in a container (workspace draft + live published version)."""
    try:
        client = get_gtm_client()
        chosen, workspaces = _choose_workspace(client, account_id, container_id, workspace_id)
        if chosen is None:
            return {
                "status": "error",
                "message": f"No workspace found for container {container_id}",
                "workspaces": workspaces,
            }
        ws_id = str(chosen.get("workspaceId"))
        workspace_variables = client.list_variables(account_id, container_id, ws_id)
        live = {}
        live_error = None
        try:
            live = client.get_live_version(account_id, container_id)
        except Exception as e:
            live_error = str(e)
        live_variables = live.get("variable", []) if live else []
        return {
            "status": "success",
            "account_id": account_id,
            "container_id": container_id,
            "workspaces": [
                {"workspaceId": w.get("workspaceId"), "name": w.get("name")}
                for w in workspaces
            ],
            "workspace": {"workspaceId": ws_id, "name": chosen.get("name")},
            "workspace_variable_count": len(workspace_variables),
            "workspace_variables": [_summarize_variable(v) for v in workspace_variables],
            "live_version": {
                "name": live.get("name") or live.get("containerVersionId"),
                "containerVersionId": live.get("containerVersionId"),
                "error": live_error,
            },
            "live_variables": [_summarize_variable(v) for v in live_variables],
        }
    except Exception as e:
        return {"status": "error", "message": f"Failed to list variables: {str(e)}"}


@mcp.tool()
def update_gtm_tag(
    account_id: str,
    container_id: str,
    tag_id: str,
    name: str = "",
    paused: str = "",
    workspace_id: str = "",
) -> dict:
    """Fingerprint-safe tag update. Set name and/or paused ('true'/'false'). Does not change firing, HTML, or parameters."""
    try:
        new_name = (name or "").strip() or None
        paused_arg = None
        paused_raw = (paused or "").strip().lower()
        if paused_raw in ("true", "1", "yes", "pause"):
            paused_arg = True
        elif paused_raw in ("false", "0", "no", "unpause"):
            paused_arg = False
        if new_name is None and paused_arg is None:
            return {
                "status": "error",
                "message": "Provide name and/or paused ('true' or 'false').",
            }
        client = get_gtm_client()
        ws_id = client.resolve_workspace_id(account_id, container_id, workspace_id)
        result = client.update_tag(
            account_id, container_id, ws_id, str(tag_id), name=new_name, paused=paused_arg
        )
        return {"status": "success", "workspace_id": ws_id, **result}
    except Exception as e:
        return {"status": "error", "message": f"Failed to update tag: {str(e)}"}


@mcp.tool()
def get_gtm_tag(
    account_id: str,
    container_id: str,
    tag_id: str,
    workspace_id: str = "",
) -> dict:
    """Get a workspace tag, including Custom HTML body when present."""
    try:
        client = get_gtm_client()
        ws_id = client.resolve_workspace_id(account_id, container_id, workspace_id)
        tag = client.get_tag(account_id, container_id, ws_id, str(tag_id))
        html = ""
        for param in tag.get("parameter") or []:
            if param.get("key") == "html":
                html = param.get("value") or ""
                break
        return {
            "status": "success",
            "workspace_id": ws_id,
            "tagId": tag.get("tagId"),
            "name": tag.get("name"),
            "type": tag.get("type"),
            "paused": tag.get("paused", False),
            "firingTriggerId": tag.get("firingTriggerId", []),
            "html": html,
        }
    except Exception as e:
        return {"status": "error", "message": f"Failed to get tag: {str(e)}"}


@mcp.tool()
def update_html_tag(
    account_id: str,
    container_id: str,
    tag_id: str,
    html: str,
    workspace_id: str = "",
) -> dict:
    """Update a Custom HTML tag body on Default Workspace (or workspace_id). Keeps triggers."""
    try:
        html_value = (html or "").strip()
        if not html_value:
            return {"status": "error", "message": "html is required"}
        client = get_gtm_client()
        ws_id = client.resolve_workspace_id(account_id, container_id, workspace_id)
        result = client.update_html_tag(
            account_id, container_id, ws_id, str(tag_id), html_value
        )
        return {"status": "success", "workspace_id": ws_id, **result}
    except Exception as e:
        return {"status": "error", "message": f"Failed to update HTML tag: {str(e)}"}


@mcp.tool()
def update_gtm_trigger(
    account_id: str,
    container_id: str,
    trigger_id: str,
    name: str,
    workspace_id: str = "",
) -> dict:
    """Fingerprint-safe trigger rename. Name only — does not change type or filters."""
    try:
        new_name = (name or "").strip()
        if not new_name:
            return {"status": "error", "message": "name is required"}
        client = get_gtm_client()
        ws_id = client.resolve_workspace_id(account_id, container_id, workspace_id)
        result = client.update_trigger(
            account_id, container_id, ws_id, str(trigger_id), new_name
        )
        return {"status": "success", "workspace_id": ws_id, **result}
    except Exception as e:
        return {"status": "error", "message": f"Failed to update trigger: {str(e)}"}


@mcp.tool()
def update_gtm_variable(
    account_id: str,
    container_id: str,
    variable_id: str,
    name: str,
    workspace_id: str = "",
) -> dict:
    """Fingerprint-safe variable rename. Name only — does not change type or parameters."""
    try:
        new_name = (name or "").strip()
        if not new_name:
            return {"status": "error", "message": "name is required"}
        client = get_gtm_client()
        ws_id = client.resolve_workspace_id(account_id, container_id, workspace_id)
        result = client.update_variable(
            account_id, container_id, ws_id, str(variable_id), new_name
        )
        return {"status": "success", "workspace_id": ws_id, **result}
    except Exception as e:
        return {"status": "error", "message": f"Failed to update variable: {str(e)}"}


@mcp.tool()
def analyze_tag_assistant_export(file_path: str, expected_send_to: list = None) -> dict:
    """Summarize a local Tag Assistant v2 JSON export (no network). Pass expected_send_to labels to count conversions."""
    try:
        from gtm_qa import analyze_tag_assistant_export as _analyze
        return _analyze(file_path, expected_send_to)
    except Exception as e:
        return {"status": "error", "message": str(e)}


@mcp.tool()
def inspect_live_gtm_js(public_id: str, needles: list = None) -> dict:
    """Inspect published gtm.js Custom HTML (public file). Reports send_to labels, tour flag, paused tag ids."""
    try:
        from gtm_qa import inspect_live_gtm_js as _inspect
        return _inspect(public_id, needles)
    except Exception as e:
        return {"status": "error", "message": str(e)}


@mcp.tool()
def create_ga4_setup(account_id: str, container_id: str, measurement_id: str, enhanced_ecommerce: bool = False) -> dict:
    """Create complete GA4 setup in GTM (실제 GTM에 생성)"""
    try:
        if not HAS_GTM_COMPONENTS:
            return {"status": "error", "message": "GTM components not available"}
        
        client = get_gtm_client()
        
        # Build GA4 workflow
        builder = GTMWorkflowBuilder()
        builder.add_google_analytics_4_setup(measurement_id, enhanced_ecommerce)
        builder.add_common_variables()
        
        components = builder.get_components()
        results = {
            "status": "success",
            "setup_type": "GA4",
            "measurement_id": measurement_id,
            "enhanced_ecommerce": enhanced_ecommerce,
            "created_components": []
        }
        
        # Create variables first
        for variable in components['variables']:
            try:
                result = client.create_variable(
                    account_id, container_id, 
                    variable['name'], variable['type'], 
                    variable.get('parameters', {})
                )
                results["created_components"].append({
                    "type": "variable", 
                    "name": variable['name'], 
                    "status": "success", 
                    "id": result.get('variableId')
                })
            except Exception as e:
                results["created_components"].append({
                    "type": "variable", 
                    "name": variable['name'], 
                    "status": "error", 
                    "error": str(e)
                })
        
        # Create triggers
        for trigger in components['triggers']:
            try:
                result = client.create_trigger(
                    account_id, container_id,
                    trigger['name'], trigger['type'],
                    trigger.get('filters', [])
                )
                results["created_components"].append({
                    "type": "trigger", 
                    "name": trigger['name'], 
                    "status": "success", 
                    "id": result.get('triggerId')
                })
            except Exception as e:
                results["created_components"].append({
                    "type": "trigger", 
                    "name": trigger['name'], 
                    "status": "error", 
                    "error": str(e)
                })
        
        # Create tags
        for tag in components['tags']:
            try:
                result = client.create_tag(
                    account_id, container_id,
                    tag['name'], tag['type'],
                    tag.get('parameters', {})
                )
                results["created_components"].append({
                    "type": "tag", 
                    "name": tag['name'], 
                    "status": "success", 
                    "id": result.get('tagId')
                })
            except Exception as e:
                results["created_components"].append({
                    "type": "tag", 
                    "name": tag['name'], 
                    "status": "error", 
                    "error": str(e)
                })
        
        return results
        
    except Exception as e:
        return {
            "status": "error",
            "message": f"Failed to create GA4 setup: {str(e)}"
        }

@mcp.tool()
def create_facebook_pixel_setup(account_id: str, container_id: str, pixel_id: str) -> dict:
    """Create Facebook Pixel setup in GTM (실제 GTM에 생성)"""
    try:
        if not HAS_GTM_COMPONENTS:
            return {"status": "error", "message": "GTM components not available"}
        
        client = get_gtm_client()
        
        # Build Facebook Pixel workflow
        builder = GTMWorkflowBuilder()
        builder.add_facebook_pixel_setup(pixel_id)
        
        components = builder.get_components()
        results = {
            "status": "success",
            "setup_type": "Facebook Pixel",
            "pixel_id": pixel_id,
            "created_components": []
        }
        
        # Create triggers and tags
        for trigger in components['triggers']:
            try:
                result = client.create_trigger(
                    account_id, container_id,
                    trigger['name'], trigger['type'],
                    trigger.get('filters', [])
                )
                results["created_components"].append({
                    "type": "trigger", 
                    "name": trigger['name'], 
                    "status": "success", 
                    "id": result.get('triggerId')
                })
            except Exception as e:
                results["created_components"].append({
                    "type": "trigger", 
                    "name": trigger['name'], 
                    "status": "error", 
                    "error": str(e)
                })
        
        for tag in components['tags']:
            try:
                result = client.create_tag(
                    account_id, container_id,
                    tag['name'], tag['type'],
                    tag.get('parameters', {})
                )
                results["created_components"].append({
                    "type": "tag", 
                    "name": tag['name'], 
                    "status": "success", 
                    "id": result.get('tagId')
                })
            except Exception as e:
                results["created_components"].append({
                    "type": "tag", 
                    "name": tag['name'], 
                    "status": "error", 
                    "error": str(e)
                })
        
        return results
        
    except Exception as e:
        return {
            "status": "error",
            "message": f"Failed to create Facebook Pixel setup: {str(e)}"
        }

@mcp.tool()
def create_complete_ecommerce_setup(account_id: str, container_id: str, ga4_measurement_id: str, facebook_pixel_id: str = None, include_conversion_tracking: bool = True) -> dict:
    """Create complete ecommerce tracking setup in GTM (실제 GTM에 생성)"""
    try:
        if not HAS_GTM_COMPONENTS:
            return {"status": "error", "message": "GTM components not available"}
        
        client = get_gtm_client()
        
        # Build complete ecommerce workflow
        builder = GTMWorkflowBuilder()
        builder.add_google_analytics_4_setup(ga4_measurement_id, enhanced_ecommerce=True)
        
        if facebook_pixel_id:
            builder.add_facebook_pixel_setup(facebook_pixel_id)
        
        if include_conversion_tracking:
            builder.add_conversion_tracking()
        
        # Ecommerce specific tracking
        builder.add_form_tracking('#checkout-form')
        builder.add_click_tracking('.add-to-cart', 'add_to_cart')
        builder.add_click_tracking('.buy-now', 'purchase_intent')
        builder.add_common_variables()
        
        components = builder.get_components()
        results = {
            "status": "success",
            "setup_type": "Complete Ecommerce Workflow",
            "ga4_measurement_id": ga4_measurement_id,
            "facebook_pixel_id": facebook_pixel_id,
            "includes_conversion_tracking": include_conversion_tracking,
            "created_components": []
        }
        
        # Create all components
        all_components = [
            ("variable", components['variables']),
            ("trigger", components['triggers']),
            ("tag", components['tags'])
        ]
        
        for component_type, component_list in all_components:
            for component in component_list:
                try:
                    if component_type == "variable":
                        result = client.create_variable(
                            account_id, container_id,
                            component['name'], component['type'],
                            component.get('parameters', {})
                        )
                    elif component_type == "trigger":
                        result = client.create_trigger(
                            account_id, container_id,
                            component['name'], component['type'],
                            component.get('filters', [])
                        )
                    elif component_type == "tag":
                        result = client.create_tag(
                            account_id, container_id,
                            component['name'], component['type'],
                            component.get('parameters', {})
                        )
                    
                    results["created_components"].append({
                        "type": component_type,
                        "name": component['name'],
                        "status": "success",
                        "id": result.get(f'{component_type}Id')
                    })
                except Exception as e:
                    results["created_components"].append({
                        "type": component_type,
                        "name": component['name'],
                        "status": "error",
                        "error": str(e)
                    })
        
        return results
        
    except Exception as e:
        return {
            "status": "error",
            "message": f"Failed to create ecommerce setup: {str(e)}"
        }

@mcp.tool()
def publish_gtm_container(account_id: str, container_id: str, version_name: str, version_notes: str = "Published via MCP") -> dict:
    """Publish GTM container version (실제 배포)"""
    try:
        client = get_gtm_client()
        
        result = client.publish_version(account_id, container_id, version_name, version_notes)
        
        publish_result = {
            "status": "success",
            "message": f"Container {container_id} published successfully",
            "version_name": version_name,
            "version_notes": version_notes,
            "published_version": result
        }
        return publish_result
        
    except Exception as e:
        return {
            "status": "error",
            "message": f"Failed to publish container: {str(e)}"
        }

@mcp.tool()
def generate_ga4_template(measurement_id: str, config_parameters: dict = None) -> dict:
    """Generate GA4 tag template (JSON only)"""
    try:
        if not HAS_GTM_COMPONENTS:
            return {"status": "error", "message": "GTM components not available"}
        
        if config_parameters is None:
            config_parameters = {}
        
        ga4_tag = GTMComponentTemplates.google_analytics_4_tag(measurement_id, config_parameters)
        
        result = {
            "status": "success",
            "template_type": "GA4 Configuration Tag",
            "measurement_id": measurement_id,
            "template": ga4_tag,
            "usage": "Copy this JSON template and import it into your GTM container"
        }
        return result
        
    except Exception as e:
        return {
            "status": "error",
            "message": f"Failed to generate GA4 template: {str(e)}"
        }

# Run the MCP server
if __name__ == '__main__':
    logger.info("Starting FastMCP GTM Server...")
    mcp.run()