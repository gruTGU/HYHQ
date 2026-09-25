from django.urls import path
from .views import (LocationList, WeatherSummary, WeatherForecast, ReminderStatus, ReminderIntent,
                    ReminderConsent, ReminderCancel)

urlpatterns = [
    path('locations/', LocationList.as_view(), name='weather-data-locations'),
    path('summary/', WeatherSummary.as_view(), name='weather-data-summary'),
    path('<slug:slug>/forecast/', WeatherForecast.as_view(), name='weather-data-forecast'),
    path('reminders/', ReminderStatus.as_view(), name='weather-reminders'),
    path('reminders/intents/', ReminderIntent.as_view(), name='weather-reminder-intent'),
    path('reminders/<uuid:reminder_id>/consent/', ReminderConsent.as_view(), name='weather-reminder-consent'),
    path('reminders/<uuid:reminder_id>/cancel/', ReminderCancel.as_view(), name='weather-reminder-cancel'),
]
