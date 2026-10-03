from django.http import HttpResponse, JsonResponse
from .health import ready


class CloudBoundaryMiddleware:
    """Only exact safe probes bypass HTTPS; cloud Admin is always inaccessible."""
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.path in {'/_cloud/live', '/_cloud/ready'}:
            if request.method not in {'GET', 'HEAD'}:
                return HttpResponse(status=405)
            healthy = request.path == '/_cloud/live' or ready()
            response = JsonResponse({'ok': healthy}, status=200 if healthy else 503)
            response['Cache-Control'] = 'no-store'
            response['X-Content-Type-Options'] = 'nosniff'
            return response
        if request.path == '/admin' or request.path.startswith('/admin/'):
            return HttpResponse(status=404)
        return self.get_response(request)
