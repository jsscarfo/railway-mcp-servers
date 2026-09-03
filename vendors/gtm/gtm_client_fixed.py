import os
import json
import logging
import sys
from typing import Any, Dict, List, Optional
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

# Redirect Google client logs to stderr
google_logger = logging.getLogger('google.auth')
google_logger.addHandler(logging.StreamHandler(sys.stderr))

logger = logging.getLogger(__name__)

class GTMClient:
    SCOPES = [
        'https://www.googleapis.com/auth/tagmanager.edit.containers',
        'https://www.googleapis.com/auth/tagmanager.publish',
    ]
    
    def __init__(self, credentials_file: Optional[str] = None, token_file: Optional[str] = None):
        self.credentials_file = credentials_file or os.getenv('GTM_CREDENTIALS_FILE', 'credentials.json')
        self.token_file = token_file or os.getenv('GTM_TOKEN_FILE', 'token.json')
        self.service = None
        
        # Print authentication status to stderr (not stdout)
        print(f"GTM Client initializing with credentials: {self.credentials_file}", file=sys.stderr)
        self._authenticate()

    def _authenticate(self):
        creds = None
        
        # Load existing token
        if os.path.exists(self.token_file):
            print(f"Loading existing token from {self.token_file}", file=sys.stderr)
            try:
                creds = Credentials.from_authorized_user_file(self.token_file, self.SCOPES)
                print("Token loaded successfully", file=sys.stderr)
            except Exception as e:
                print(f"Failed to load token: {e}", file=sys.stderr)
                creds = None
        
        # Check if credentials are valid
        if not creds or not creds.valid:
            if creds and creds.expired and creds.refresh_token:
                print("Token expired, attempting refresh...", file=sys.stderr)
                try:
                    creds.refresh(Request())
                    print("Token refreshed successfully", file=sys.stderr)
                except Exception as e:
                    print(f"Token refresh failed: {e}", file=sys.stderr)
                    creds = None
            
            # If still no valid credentials, start OAuth flow
            if not creds:
                if not os.path.exists(self.credentials_file):
                    error_msg = f"Credentials file not found: {self.credentials_file}"
                    print(error_msg, file=sys.stderr)
                    raise FileNotFoundError(
                        f"{error_msg}. Please download credentials.json from Google Cloud Console."
                    )
                
                print("Starting OAuth flow...", file=sys.stderr)
                try:
                    flow = InstalledAppFlow.from_client_secrets_file(
                        self.credentials_file, self.SCOPES)
                    
                    # Try to use local server for authentication
                    print("Opening browser for authentication...", file=sys.stderr)
                    creds = flow.run_local_server(
                        port=0,  # Use random available port
                        access_type='offline',
                        include_granted_scopes='true',
                        open_browser=True
                    )
                    print("Authentication successful!", file=sys.stderr)
                    
                except Exception as e:
                    error_msg = f"Authentication failed: {e}"
                    print(error_msg, file=sys.stderr)
                    raise Exception(error_msg)
            
            # Save the credentials for the next run
            print(f"Saving credentials to {self.token_file}", file=sys.stderr)
            try:
                with open(self.token_file, 'w') as token:
                    token.write(creds.to_json())
                print("Credentials saved successfully", file=sys.stderr)
            except Exception as e:
                print(f"Failed to save credentials: {e}", file=sys.stderr)

        # Build the service
        try:
            print("Building GTM service...", file=sys.stderr)
            self.service = build('tagmanager', 'v2', credentials=creds)
            print("GTM service built successfully", file=sys.stderr)
        except Exception as e:
            error_msg = f"Failed to build GTM service: {e}"
            print(error_msg, file=sys.stderr)
            raise Exception(error_msg)

    def create_tag(self, account_id: str, container_id: str, name: str, tag_type: str, parameters: Dict[str, Any]) -> Dict[str, Any]:
        try:
            parent = f"accounts/{account_id}/containers/{container_id}/workspaces/1"
            
            tag_body = {
                'name': name,
                'type': tag_type,
                'parameter': [
                    {'key': key, 'value': value, 'type': 'template'}
                    for key, value in parameters.items()
                ]
            }
            
            print(f"Creating tag: {name}", file=sys.stderr)
            result = self.service.accounts().containers().workspaces().tags().create(
                parent=parent,
                body=tag_body
            ).execute()
            
            print(f"Tag created successfully: {result.get('name', 'Unknown')}", file=sys.stderr)
            return result
            
        except HttpError as e:
            error_msg = f"Error creating tag {name}: {e}"
            print(error_msg, file=sys.stderr)
            raise Exception(error_msg)

    def create_trigger(self, account_id: str, container_id: str, name: str, trigger_type: str, filters: List[Dict[str, Any]]) -> Dict[str, Any]:
        try:
            parent = f"accounts/{account_id}/containers/{container_id}/workspaces/1"
            
            trigger_body = {
                'name': name,
                'type': trigger_type,
                'filter': filters
            }
            
            print(f"Creating trigger: {name}", file=sys.stderr)
            result = self.service.accounts().containers().workspaces().triggers().create(
                parent=parent,
                body=trigger_body
            ).execute()
            
            print(f"Trigger created successfully: {result.get('name', 'Unknown')}", file=sys.stderr)
            return result
            
        except HttpError as e:
            error_msg = f"Error creating trigger {name}: {e}"
            print(error_msg, file=sys.stderr)
            raise Exception(error_msg)

    def create_variable(self, account_id: str, container_id: str, name: str, variable_type: str, parameters: Dict[str, Any]) -> Dict[str, Any]:
        try:
            parent = f"accounts/{account_id}/containers/{container_id}/workspaces/1"
            
            variable_body = {
                'name': name,
                'type': variable_type,
                'parameter': [
                    {'key': key, 'value': value, 'type': 'template'}
                    for key, value in parameters.items()
                ]
            }
            
            print(f"Creating variable: {name}", file=sys.stderr)
            result = self.service.accounts().containers().workspaces().variables().create(
                parent=parent,
                body=variable_body
            ).execute()
            
            print(f"Variable created successfully: {result.get('name', 'Unknown')}", file=sys.stderr)
            return result
            
        except HttpError as e:
            error_msg = f"Error creating variable {name}: {e}"
            print(error_msg, file=sys.stderr)
            raise Exception(error_msg)

    def list_containers(self, account_id: str) -> List[Dict[str, Any]]:
        try:
            parent = f"accounts/{account_id}"
            
            print(f"Listing containers for account {account_id}", file=sys.stderr)
            result = self.service.accounts().containers().list(parent=parent).execute()
            containers = result.get('container', [])
            
            print(f"Found {len(containers)} containers", file=sys.stderr)
            return containers
            
        except HttpError as e:
            error_msg = f"Error listing containers: {e}"
            print(error_msg, file=sys.stderr)
            raise Exception(error_msg)

    def get_container(self, account_id: str, container_id: str) -> Dict[str, Any]:
        try:
            path = f"accounts/{account_id}/containers/{container_id}"
            
            print(f"Getting container {container_id}", file=sys.stderr)
            result = self.service.accounts().containers().get(path=path).execute()
            
            print(f"Retrieved container: {result.get('name', 'Unknown')}", file=sys.stderr)
            return result
            
        except HttpError as e:
            error_msg = f"Error getting container: {e}"
            print(error_msg, file=sys.stderr)
            raise Exception(error_msg)

    def list_accounts(self) -> List[Dict[str, Any]]:
        try:
            print("Listing GTM accounts", file=sys.stderr)
            result = self.service.accounts().list().execute()
            accounts = result.get("account", [])
            print(f"Found {len(accounts)} accounts", file=sys.stderr)
            return accounts
        except HttpError as e:
            error_msg = f"Error listing accounts: {e}"
            print(error_msg, file=sys.stderr)
            raise Exception(error_msg)

    def list_workspaces(self, account_id: str, container_id: str) -> List[Dict[str, Any]]:
        try:
            parent = f"accounts/{account_id}/containers/{container_id}"
            print(f"Listing workspaces for {parent}", file=sys.stderr)
            result = self.service.accounts().containers().workspaces().list(parent=parent).execute()
            workspaces = result.get("workspace", [])
            print(f"Found {len(workspaces)} workspaces", file=sys.stderr)
            return workspaces
        except HttpError as e:
            error_msg = f"Error listing workspaces: {e}"
            print(error_msg, file=sys.stderr)
            raise Exception(error_msg)

    def list_tags(self, account_id: str, container_id: str, workspace_id: str) -> List[Dict[str, Any]]:
        try:
            parent = f"accounts/{account_id}/containers/{container_id}/workspaces/{workspace_id}"
            print(f"Listing tags for {parent}", file=sys.stderr)
            result = self.service.accounts().containers().workspaces().tags().list(parent=parent).execute()
            tags = result.get("tag", [])
            print(f"Found {len(tags)} tags", file=sys.stderr)
            return tags
        except HttpError as e:
            error_msg = f"Error listing tags: {e}"
            print(error_msg, file=sys.stderr)
            raise Exception(error_msg)

    def get_live_version(self, account_id: str, container_id: str) -> Dict[str, Any]:
        try:
            parent = f"accounts/{account_id}/containers/{container_id}"
            print(f"Getting live version for {parent}", file=sys.stderr)
            try:
                result = self.service.accounts().containers().versions().live(
                    parent=parent
                ).execute()
            except TypeError:
                result = self.service.accounts().containers().versions().get(
                    path=f"{parent}/versions/live"
                ).execute()
            print(
                f"Live version: {result.get('name', 'Unknown')} "
                f"tags={len(result.get('tag', []))}",
                file=sys.stderr,
            )
            return result
        except HttpError as e:
            error_msg = f"Error getting live version: {e}"
            print(error_msg, file=sys.stderr)
            raise Exception(error_msg)

    def resolve_workspace_id(
        self, account_id: str, container_id: str, workspace_id: str = ""
    ) -> str:
        if (workspace_id or "").strip():
            return str(workspace_id).strip()
        workspaces = self.list_workspaces(account_id, container_id)
        chosen = next(
            (w for w in workspaces if w.get("name") == "Default Workspace"),
            workspaces[0] if workspaces else None,
        )
        if chosen is None:
            raise Exception(f"No workspace found for container {container_id}")
        return str(chosen.get("workspaceId"))

    def _workspace_parent(
        self, account_id: str, container_id: str, workspace_id: str = ""
    ) -> str:
        ws = self.resolve_workspace_id(account_id, container_id, workspace_id)
        return f"accounts/{account_id}/containers/{container_id}/workspaces/{ws}"

    def list_triggers(
        self, account_id: str, container_id: str, workspace_id: str
    ) -> List[Dict[str, Any]]:
        try:
            parent = f"accounts/{account_id}/containers/{container_id}/workspaces/{workspace_id}"
            print(f"Listing triggers for {parent}", file=sys.stderr)
            result = self.service.accounts().containers().workspaces().triggers().list(
                parent=parent
            ).execute()
            triggers = result.get("trigger", [])
            print(f"Found {len(triggers)} triggers", file=sys.stderr)
            return triggers
        except HttpError as e:
            error_msg = f"Error listing triggers: {e}"
            print(error_msg, file=sys.stderr)
            raise Exception(error_msg)

    def list_variables(
        self, account_id: str, container_id: str, workspace_id: str
    ) -> List[Dict[str, Any]]:
        try:
            parent = f"accounts/{account_id}/containers/{container_id}/workspaces/{workspace_id}"
            print(f"Listing variables for {parent}", file=sys.stderr)
            result = self.service.accounts().containers().workspaces().variables().list(
                parent=parent
            ).execute()
            variables = result.get("variable", [])
            print(f"Found {len(variables)} variables", file=sys.stderr)
            return variables
        except HttpError as e:
            error_msg = f"Error listing variables: {e}"
            print(error_msg, file=sys.stderr)
            raise Exception(error_msg)

    def get_tag(
        self, account_id: str, container_id: str, workspace_id: str, tag_id: str
    ) -> Dict[str, Any]:
        path = (
            f"accounts/{account_id}/containers/{container_id}"
            f"/workspaces/{workspace_id}/tags/{tag_id}"
        )
        return self.service.accounts().containers().workspaces().tags().get(
            path=path
        ).execute()

    def get_trigger(
        self, account_id: str, container_id: str, workspace_id: str, trigger_id: str
    ) -> Dict[str, Any]:
        path = (
            f"accounts/{account_id}/containers/{container_id}"
            f"/workspaces/{workspace_id}/triggers/{trigger_id}"
        )
        return self.service.accounts().containers().workspaces().triggers().get(
            path=path
        ).execute()

    def get_variable(
        self, account_id: str, container_id: str, workspace_id: str, variable_id: str
    ) -> Dict[str, Any]:
        path = (
            f"accounts/{account_id}/containers/{container_id}"
            f"/workspaces/{workspace_id}/variables/{variable_id}"
        )
        return self.service.accounts().containers().workspaces().variables().get(
            path=path
        ).execute()

    def update_tag(
        self,
        account_id: str,
        container_id: str,
        workspace_id: str,
        tag_id: str,
        name: Optional[str] = None,
        paused: Optional[bool] = None,
    ) -> Dict[str, Any]:
        """Fingerprint-safe tag update. Name and/or paused only — never parameters or triggers."""
        if name is None and paused is None:
            raise ValueError("update_tag requires name and/or paused")
        tag = self.get_tag(account_id, container_id, workspace_id, tag_id)
        before = {"name": tag.get("name"), "paused": tag.get("paused", False)}
        if name is not None:
            tag["name"] = name
        if paused is not None:
            tag["paused"] = bool(paused)
        print(
            f"Updating tag {tag_id}: name {before['name']!r} -> {tag.get('name')!r} "
            f"paused {before['paused']} -> {tag.get('paused', False)}",
            file=sys.stderr,
        )
        result = self.service.accounts().containers().workspaces().tags().update(
            path=tag["path"],
            body=tag,
        ).execute()
        return {
            "tagId": result.get("tagId"),
            "name": result.get("name"),
            "paused": result.get("paused", False),
            "fingerprint": result.get("fingerprint"),
            "before": before,
        }

    def update_html_tag(
        self,
        account_id: str,
        container_id: str,
        workspace_id: str,
        tag_id: str,
        html: str,
    ) -> Dict[str, Any]:
        """Update a Custom HTML tag body. Keeps name, paused, and firing triggers."""
        html_value = (html or "").strip()
        if not html_value:
            raise ValueError("update_html_tag requires html")
        tag = self.get_tag(account_id, container_id, workspace_id, tag_id)
        if tag.get("type") != "html":
            raise ValueError(
                f"tag {tag_id} type is {tag.get('type')!r}, expected 'html'"
            )
        params = list(tag.get("parameter") or [])
        found = False
        for param in params:
            if param.get("key") == "html":
                param["type"] = "template"
                param["value"] = html_value
                found = True
                break
        if not found:
            params.append({"type": "template", "key": "html", "value": html_value})
        tag["parameter"] = params
        print(
            f"Updating HTML tag {tag_id} ({tag.get('name')!r}) html_len={len(html_value)}",
            file=sys.stderr,
        )
        result = self.service.accounts().containers().workspaces().tags().update(
            path=tag["path"],
            body=tag,
        ).execute()
        html_out = ""
        for param in result.get("parameter") or []:
            if param.get("key") == "html":
                html_out = param.get("value") or ""
                break
        return {
            "tagId": result.get("tagId"),
            "name": result.get("name"),
            "type": result.get("type"),
            "paused": result.get("paused", False),
            "firingTriggerId": result.get("firingTriggerId", []),
            "fingerprint": result.get("fingerprint"),
            "html_len": len(html_out),
        }

    def update_trigger(
        self,
        account_id: str,
        container_id: str,
        workspace_id: str,
        trigger_id: str,
        name: str,
    ) -> Dict[str, Any]:
        """Fingerprint-safe trigger rename. Name only — never type or filters."""
        trigger = self.get_trigger(account_id, container_id, workspace_id, trigger_id)
        before = trigger.get("name")
        trigger["name"] = name
        print(
            f"Updating trigger {trigger_id}: {before!r} -> {name!r}",
            file=sys.stderr,
        )
        result = self.service.accounts().containers().workspaces().triggers().update(
            path=trigger["path"],
            body=trigger,
        ).execute()
        return {
            "triggerId": result.get("triggerId"),
            "name": result.get("name"),
            "type": result.get("type"),
            "fingerprint": result.get("fingerprint"),
            "before": before,
        }

    def update_variable(
        self,
        account_id: str,
        container_id: str,
        workspace_id: str,
        variable_id: str,
        name: str,
    ) -> Dict[str, Any]:
        """Fingerprint-safe variable rename. Name only — never type or parameters."""
        variable = self.get_variable(account_id, container_id, workspace_id, variable_id)
        before = variable.get("name")
        variable["name"] = name
        print(
            f"Updating variable {variable_id}: {before!r} -> {name!r}",
            file=sys.stderr,
        )
        result = self.service.accounts().containers().workspaces().variables().update(
            path=variable["path"],
            body=variable,
        ).execute()
        return {
            "variableId": result.get("variableId"),
            "name": result.get("name"),
            "type": result.get("type"),
            "fingerprint": result.get("fingerprint"),
            "before": before,
        }

    def publish_version(self, account_id: str, container_id: str, version_name: str, version_notes: str = "") -> Dict[str, Any]:
        try:
            parent = self._workspace_parent(account_id, container_id)
            version_body = {
                'name': version_name,
                'notes': version_notes
            }
            
            print(f"Creating version: {version_name} from {parent}", file=sys.stderr)
            try:
                create_result = self.service.accounts().containers().workspaces().create_version(
                    path=parent,
                    body=version_body
                ).execute()
            except TypeError:
            create_result = self.service.accounts().containers().workspaces().create_version(
                parent=parent,
                body=version_body
            ).execute()
            
            container_version = create_result.get("containerVersion") or create_result
            version_path = container_version.get("path") or create_result.get("path")
            if not version_path:
                raise Exception(f"create_version returned no path: {create_result}")
            
            print(f"Publishing version: {version_name}", file=sys.stderr)
            publish_result = self.service.accounts().containers().versions().publish(
                path=version_path
            ).execute()
            
            print(f"Version published successfully: {version_name}", file=sys.stderr)
            return publish_result
            
        except HttpError as e:
            error_msg = f"Error publishing version: {e}"
            print(error_msg, file=sys.stderr)
            raise Exception(error_msg)
