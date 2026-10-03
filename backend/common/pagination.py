from rest_framework.pagination import PageNumberPagination
from rest_framework.response import Response
from .urls import pagination_uri


class StandardPagination(PageNumberPagination):
    page_size = 20
    page_size_query_param = 'page_size'
    max_page_size = 100

    def get_paginated_response(self, data):
        return Response({'data': data, 'meta': {'count': self.page.paginator.count, 'next': pagination_uri(self.get_next_link()),
                                               'previous': pagination_uri(self.get_previous_link()), 'page': self.page.number,
                                               'page_size': self.get_page_size(self.request)}})
