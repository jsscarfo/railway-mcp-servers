import os
import json
import logging
from typing import Any, Dict, List, Optional
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

logger = logging.getLogger(__name__)

class GTMClient:
    SCOPES = ['https://www.googleapis.com/auth/tagmanager.edit.containers']
    
    def __init__(self, credentials_file: Optional[str] = None, token_file: Optional[str] = None):
        self.credentials_file = credentials_file or os.getenv('GTM_CREDENTIALS_FILE', 'credentials.json')
        self.token_file = token_file or os.getenv('GTM_TOKEN_FILE', 'token.json')
        self.service = None
        self._authenticate()

    def _authenticate(self):
        creds = None
        if os.path.exists(self.token_file):
            creds = Credentials.from_authorized_user_file(self.token_file, self.SCOPES)
        
        if not creds or not creds.valid:
            if creds and creds.expired and creds.refresh_token:
                try:
                    creds.refresh(Request())
                except Exception as e:
                    logger.warning(f"Token refresh failed: {e}")
                    creds = None
            
            if not creds:
                if not os.path.exists(self.credentials_file):
                    raise FileNotFoundError(
                        f"Credentials file not found: {self.credentials_file}. "
                        "Please download it from Google Cloud Console and place it in the correct location."
                    )
                
                # Check if running in headless environment
                try:
                    flow = InstalledAppFlow.from_client_secrets_file(
                        self.credentials_file, self.SCOPES)
                    
                    # Try to use local server for authentication
                    creds = flow.run_local_server(
                        port=0,  # Use random available port
                        access_type='offline',
                        include_granted_scopes='true',
                        open_browser=True
                    )
                except Exception as e:
                    logger.error(f"Authentication failed: {e}")
                    raise Exception(
                        f"Authentication failed: {e}. "
                        "Please ensure you have proper credentials and can access a browser."
                    )
            
            # Save the credentials for the next run
            with open(self.token_file, 'w') as token:
                token.write(creds.to_json())

        try:
            self.service = build('tagmanager', 'v2', credentials=creds)
        except Exception as e:
            logger.error(f"Failed to build GTM service: {e}")
            raise Exception(f"Failed to initialize GTM service: {e}")

    async def create_tag(self, account_id: str, container_id: str, name: str, tag_type: str, parameters: Dict[str, Any]) -> Dict[str, Any]:
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
            
            result = self.service.accounts().containers().workspaces().tags().create(
                parent=parent,
                body=tag_body
            ).execute()
            
            logger.info(f"Created tag: {result.get('name', 'Unknown')}")
            return result
            
        except HttpError as e:
            logger.error(f"Error creating tag: {e}")
            raise Exception(f"Failed to create tag: {e}")

    async def create_trigger(self, account_id: str, container_id: str, name: str, trigger_type: str, filters: List[Dict[str, Any]]) -> Dict[str, Any]:
        try:
            parent = f"accounts/{account_id}/containers/{container_id}/workspaces/1"
            
            trigger_body = {
                'name': name,
                'type': trigger_type,
                'filter': filters
            }
            
            result = self.service.accounts().containers().workspaces().triggers().create(
                parent=parent,
                body=trigger_body
            ).execute()
            
            logger.info(f"Created trigger: {result.get('name', 'Unknown')}")
            return result
            
        except HttpError as e:
            logger.error(f"Error creating trigger: {e}")
            raise Exception(f"Failed to create trigger: {e}")

    async def create_variable(self, account_id: str, container_id: str, name: str, variable_type: str, parameters: Dict[str, Any]) -> Dict[str, Any]:
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
            
            result = self.service.accounts().containers().workspaces().variables().create(
                parent=parent,
                body=variable_body
            ).execute()
            
            logger.info(f"Created variable: {result.get('name', 'Unknown')}")
            return result
            
        except HttpError as e:
            logger.error(f"Error creating variable: {e}")
            raise Exception(f"Failed to create variable: {e}")

    async def list_containers(self, account_id: str) -> List[Dict[str, Any]]:
        try:
            parent = f"accounts/{account_id}"
            
            result = self.service.accounts().containers().list(parent=parent).execute()
            containers = result.get('container', [])
            
            logger.info(f"Found {len(containers)} containers")
            return containers
            
        except HttpError as e:
            logger.error(f"Error listing containers: {e}")
            raise Exception(f"Failed to list containers: {e}")

    async def get_container(self, account_id: str, container_id: str) -> Dict[str, Any]:
        try:
            path = f"accounts/{account_id}/containers/{container_id}"
            
            result = self.service.accounts().containers().get(path=path).execute()
            
            logger.info(f"Retrieved container: {result.get('name', 'Unknown')}")
            return result
            
        except HttpError as e:
            logger.error(f"Error getting container: {e}")
            raise Exception(f"Failed to get container: {e}")

    async def publish_version(self, account_id: str, container_id: str, version_name: str, version_notes: str = "") -> Dict[str, Any]:
        try:
            parent = f"accounts/{account_id}/containers/{container_id}/workspaces/1"
            
            version_body = {
                'name': version_name,
                'notes': version_notes
            }
            
            create_result = self.service.accounts().containers().workspaces().create_version(
                parent=parent,
                body=version_body
            ).execute()
            
            version_path = create_result['path']
            
            publish_result = self.service.accounts().containers().versions().publish(
                path=version_path
            ).execute()
            
            logger.info(f"Published version: {version_name}")
            return publish_result
            
        except HttpError as e:
            logger.error(f"Error publishing version: {e}")
            raise Exception(f"Failed to publish version: {e}")

    async def list_tags(self, account_id: str, container_id: str) -> List[Dict[str, Any]]:
        try:
            parent = f"accounts/{account_id}/containers/{container_id}/workspaces/1"
            
            result = self.service.accounts().containers().workspaces().tags().list(
                parent=parent
            ).execute()
            
            tags = result.get('tag', [])
            logger.info(f"Found {len(tags)} tags")
            return tags
            
        except HttpError as e:
            logger.error(f"Error listing tags: {e}")
            raise Exception(f"Failed to list tags: {e}")

    async def list_triggers(self, account_id: str, container_id: str) -> List[Dict[str, Any]]:
        try:
            parent = f"accounts/{account_id}/containers/{container_id}/workspaces/1"
            
            result = self.service.accounts().containers().workspaces().triggers().list(
                parent=parent
            ).execute()
            
            triggers = result.get('trigger', [])
            logger.info(f"Found {len(triggers)} triggers")
            return triggers
            
        except HttpError as e:
            logger.error(f"Error listing triggers: {e}")
            raise Exception(f"Failed to list triggers: {e}")

    async def list_variables(self, account_id: str, container_id: str) -> List[Dict[str, Any]]:
        try:
            parent = f"accounts/{account_id}/containers/{container_id}/workspaces/1"
            
            result = self.service.accounts().containers().workspaces().variables().list(
                parent=parent
            ).execute()
            
            variables = result.get('variable', [])
            logger.info(f"Found {len(variables)} variables")
            return variables
            
        except HttpError as e:
            logger.error(f"Error listing variables: {e}")
            raise Exception(f"Failed to list variables: {e}")