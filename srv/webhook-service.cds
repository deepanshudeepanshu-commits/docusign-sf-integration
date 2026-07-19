@path: '/webhook'
@requires: 'any'
service WebhookService {
    action triggerMaestroWorkflow(data: WorkflowPayload) returns String;
}

@open
type WorkflowPayload {
    workflowId : String;
}
