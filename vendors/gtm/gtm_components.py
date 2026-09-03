from typing import Dict, Any, List
import json

class GTMComponentTemplates:
    """Pre-defined templates for common GTM components"""
    
    @staticmethod
    def google_analytics_4_tag(measurement_id: str, config_parameters: Dict[str, Any] = None) -> Dict[str, Any]:
        """Create a Google Analytics 4 configuration tag"""
        parameters = {
            'measurementId': measurement_id,
            'sendPageView': 'true'
        }
        if config_parameters:
            parameters.update(config_parameters)
        
        return {
            'name': f'GA4 Config - {measurement_id}',
            'type': 'gtagjs',
            'parameters': parameters
        }
    
    @staticmethod
    def google_analytics_4_event_tag(event_name: str, event_parameters: Dict[str, Any] = None) -> Dict[str, Any]:
        """Create a Google Analytics 4 event tag"""
        if event_parameters is None:
            event_parameters = {}
        
        parameters = {
            'eventName': event_name,
            'eventAction': event_parameters.get('action', ''),
            'eventCategory': event_parameters.get('category', ''),
            'eventLabel': event_parameters.get('label', '')
        }
        parameters.update(event_parameters)
        
        return {
            'name': f'GA4 Event - {event_name}',
            'type': 'gtagjs_event',
            'parameters': parameters
        }
    
    @staticmethod
    def facebook_pixel_tag(pixel_id: str) -> Dict[str, Any]:
        """Create a Facebook Pixel tag"""
        return {
            'name': f'Facebook Pixel - {pixel_id}',
            'type': 'fbpixel',
            'parameters': {
                'pixelId': pixel_id
            }
        }
    
    @staticmethod
    def conversion_linker_tag() -> Dict[str, Any]:
        """Create a Google Ads Conversion Linker tag"""
        return {
            'name': 'Google Ads Conversion Linker',
            'type': 'gclidw',
            'parameters': {}
        }
    
    @staticmethod
    def page_view_trigger(page_url_filter: str = None) -> Dict[str, Any]:
        """Create a page view trigger"""
        filters = []
        if page_url_filter:
            filters.append({
                'type': 'equals',
                'parameter': [
                    {'key': 'arg0', 'value': '{{Page URL}}', 'type': 'template'},
                    {'key': 'arg1', 'value': page_url_filter, 'type': 'template'}
                ]
            })
        
        return {
            'name': f'Page View{" - " + page_url_filter if page_url_filter else ""}',
            'type': 'pageview',
            'filters': filters
        }
    
    @staticmethod
    def click_trigger(element_selector: str) -> Dict[str, Any]:
        """Create a click trigger for specific elements"""
        return {
            'name': f'Click - {element_selector}',
            'type': 'click',
            'filters': [
                {
                    'type': 'cssSelector',
                    'parameter': [
                        {'key': 'arg0', 'value': '{{Click Element}}', 'type': 'template'},
                        {'key': 'arg1', 'value': element_selector, 'type': 'template'}
                    ]
                }
            ]
        }
    
    @staticmethod
    def form_submit_trigger(form_selector: str = None) -> Dict[str, Any]:
        """Create a form submission trigger"""
        filters = []
        if form_selector:
            filters.append({
                'type': 'cssSelector',
                'parameter': [
                    {'key': 'arg0', 'value': '{{Form Element}}', 'type': 'template'},
                    {'key': 'arg1', 'value': form_selector, 'type': 'template'}
                ]
            })
        
        return {
            'name': f'Form Submit{" - " + form_selector if form_selector else ""}',
            'type': 'formSubmit',
            'filters': filters
        }
    
    @staticmethod
    def custom_event_trigger(event_name: str) -> Dict[str, Any]:
        """Create a custom event trigger"""
        return {
            'name': f'Custom Event - {event_name}',
            'type': 'customEvent',
            'filters': [
                {
                    'type': 'equals',
                    'parameter': [
                        {'key': 'arg0', 'value': '{{Event}}', 'type': 'template'},
                        {'key': 'arg1', 'value': event_name, 'type': 'template'}
                    ]
                }
            ]
        }
    
    @staticmethod
    def data_layer_variable(variable_name: str, data_layer_name: str) -> Dict[str, Any]:
        """Create a data layer variable"""
        return {
            'name': variable_name,
            'type': 'v',
            'parameters': {
                'dataLayerVersion': '2',
                'setDefaultValue': 'false',
                'name': data_layer_name
            }
        }
    
    @staticmethod
    def url_variable(component_type: str = 'URL') -> Dict[str, Any]:
        """Create a URL variable (URL, hostname, path, etc.)"""
        return {
            'name': f'URL - {component_type}',
            'type': 'u',
            'parameters': {
                'component': component_type.upper()
            }
        }
    
    @staticmethod
    def custom_javascript_variable(variable_name: str, javascript_code: str) -> Dict[str, Any]:
        """Create a custom JavaScript variable"""
        return {
            'name': variable_name,
            'type': 'jsm',
            'parameters': {
                'javascript': javascript_code
            }
        }

class GTMWorkflowBuilder:
    """Builder for common GTM workflows"""
    
    def __init__(self):
        self.tags = []
        self.triggers = []
        self.variables = []
    
    def add_google_analytics_4_setup(self, measurement_id: str, enhanced_ecommerce: bool = False):
        """Add complete GA4 setup"""
        # GA4 Config tag
        config_params = {}
        if enhanced_ecommerce:
            config_params['enhanced_ecommerce'] = 'true'
        
        self.tags.append(GTMComponentTemplates.google_analytics_4_tag(measurement_id, config_params))
        
        # Page view trigger
        self.triggers.append(GTMComponentTemplates.page_view_trigger())
        
        # Common GA4 event tags
        self.tags.append(GTMComponentTemplates.google_analytics_4_event_tag('purchase'))
        self.tags.append(GTMComponentTemplates.google_analytics_4_event_tag('add_to_cart'))
        
        return self
    
    def add_facebook_pixel_setup(self, pixel_id: str):
        """Add Facebook Pixel setup"""
        self.tags.append(GTMComponentTemplates.facebook_pixel_tag(pixel_id))
        self.triggers.append(GTMComponentTemplates.page_view_trigger())
        return self
    
    def add_conversion_tracking(self):
        """Add Google Ads conversion tracking"""
        self.tags.append(GTMComponentTemplates.conversion_linker_tag())
        self.triggers.append(GTMComponentTemplates.page_view_trigger())
        return self
    
    def add_form_tracking(self, form_selector: str = None):
        """Add form submission tracking"""
        self.triggers.append(GTMComponentTemplates.form_submit_trigger(form_selector))
        self.tags.append(GTMComponentTemplates.google_analytics_4_event_tag('form_submit'))
        return self
    
    def add_click_tracking(self, element_selector: str, event_name: str = 'click'):
        """Add click tracking for specific elements"""
        self.triggers.append(GTMComponentTemplates.click_trigger(element_selector))
        self.tags.append(GTMComponentTemplates.google_analytics_4_event_tag(event_name))
        return self
    
    def add_common_variables(self):
        """Add commonly used variables"""
        self.variables.extend([
            GTMComponentTemplates.url_variable('URL'),
            GTMComponentTemplates.url_variable('PATH'),
            GTMComponentTemplates.url_variable('HOSTNAME'),
            GTMComponentTemplates.data_layer_variable('DL - User ID', 'userId'),
            GTMComponentTemplates.data_layer_variable('DL - Event Category', 'eventCategory'),
            GTMComponentTemplates.data_layer_variable('DL - Event Action', 'eventAction'),
            GTMComponentTemplates.data_layer_variable('DL - Event Label', 'eventLabel')
        ])
        return self
    
    def get_components(self) -> Dict[str, List[Dict[str, Any]]]:
        """Get all built components"""
        return {
            'tags': self.tags,
            'triggers': self.triggers,
            'variables': self.variables
        }
    
    def export_json(self, filename: str = None) -> str:
        """Export components as JSON"""
        components = self.get_components()
        json_str = json.dumps(components, indent=2)
        
        if filename:
            with open(filename, 'w') as f:
                f.write(json_str)
        
        return json_str