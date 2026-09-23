import math
import uuid

from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import MaxValueValidator, MinValueValidator, URLValidator
from django.db import models
from django.utils import timezone


class ValidatedModel(models.Model):
    """Validate writes from both admin and application code (bulk writes validate separately)."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True

    def save(self, *args, **kwargs):
        self.full_clean()
        return super().save(*args, **kwargs)


class Region(ValidatedModel):
    slug = models.SlugField(unique=True)
    name = models.CharField(max_length=120)
    description = models.TextField(blank=True)
    is_demo = models.BooleanField(default=True)

    class Meta:
        ordering = ["name"]

    def __str__(self):
        return self.name


class MapLayout(ValidatedModel):
    region = models.ForeignKey(Region, on_delete=models.PROTECT, related_name="maps")
    name = models.CharField(max_length=120)
    version = models.PositiveIntegerField(default=1)
    image_url = models.CharField(max_length=500, blank=True)
    image_width = models.PositiveIntegerField(default=1000)
    image_height = models.PositiveIntegerField(default=700)
    attribution = models.CharField(max_length=500, blank=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["region", "-version"]
        constraints = [models.UniqueConstraint(fields=["region", "version"], name="map_region_version_unique")]

    def __str__(self):
        return f"{self.name} v{self.version}"

    def clean(self):
        errors = {}
        if not isinstance(self.version, int) or self.version < 1:
            errors["version"] = "底图版本必须为正整数。"
        for field in ("image_width", "image_height"):
            dimension = getattr(self, field)
            if not isinstance(dimension, int) or not 1 <= dimension <= 8192:
                errors[field] = "底图尺寸必须为 1 至 8192 像素。"
        if self.image_url and self.image_url != "/assets/maps/demo-campus-v1.png":
            try:
                URLValidator(schemes=["https"])(self.image_url)
            except ValidationError:
                errors["image_url"] = "请使用 HTTPS 图片地址，或项目内置示范底图路径。"
        if self.image_url == "/assets/maps/demo-campus-v1.png" and self.region_id:
            if self.region.slug != "demo-campus" or not self.region.is_demo or self.version != 1 or (self.image_width, self.image_height) != (1000, 700):
                errors["image_url"] = "内置示范图只适用于虚构 demo-campus 的 1000×700 布局 v1。"
        old = MapLayout.objects.filter(pk=self.pk).first() if self.pk else None
        if old and self.places.exists():
            for field in ("region_id", "version", "image_width", "image_height"):
                if getattr(old, field) != getattr(self, field):
                    errors[field.removesuffix("_id")] = "已有点位的底图不能原地改变坐标基准，请创建新版本并重新布点。"
            if old.image_url and old.image_url != self.image_url:
                errors["image_url"] = "已有图片和点位的底图不可直接换图，请创建新版本。"
        if errors:
            raise ValidationError(errors)


class Place(ValidatedModel):
    class Kind(models.TextChoices):
        RIVER = "river", "河流"
        LAKE = "lake", "湖泊"
        PARK = "park", "公园"
        PLANT = "plant", "植物点"
        WASTE = "waste", "分类投放点"
        TRAIL = "trail", "绿色步道"
        CAMPUS = "campus", "校园地点"
        LANDMARK = "landmark", "地标与停留点"

    region = models.ForeignKey(Region, on_delete=models.PROTECT, related_name="places")
    slug = models.SlugField(unique=True)
    name = models.CharField(max_length=120)
    kind = models.CharField(max_length=20, choices=Kind.choices)
    description = models.TextField(blank=True)
    map_layout = models.ForeignKey(MapLayout, on_delete=models.SET_NULL, null=True, blank=True, related_name="places")
    x_ratio = models.FloatField(null=True, blank=True, validators=[MinValueValidator(0), MaxValueValidator(1)])
    y_ratio = models.FloatField(null=True, blank=True, validators=[MinValueValidator(0), MaxValueValidator(1)])
    latitude = models.FloatField(null=True, blank=True, validators=[MinValueValidator(-90), MaxValueValidator(90)])
    longitude = models.FloatField(null=True, blank=True, validators=[MinValueValidator(-180), MaxValueValidator(180)])
    coordinate_system = models.CharField(max_length=20, blank=True, choices=[("", "未提供"), ("WGS84", "WGS84"), ("GCJ02", "GCJ02"), ("BD09", "BD09")])
    source_note = models.CharField(max_length=500, blank=True)
    is_published = models.BooleanField(default=True)

    class Meta:
        ordering = ["name"]
        indexes = [models.Index(fields=["region", "kind"])]

    def clean(self):
        errors = {}
        if self.pk and Place.objects.filter(pk=self.pk).exclude(region_id=self.region_id).exists():
            if self.stations.exists() or self.route_stops.exists() or WaterBody.objects.filter(place_id=self.pk).exists():
                errors["region"] = "已有监测站、水体或路线关联的地点不能跨区域移动。"
        if self.kind not in (self.Kind.RIVER, self.Kind.LAKE) and WaterBody.objects.filter(place_id=self.pk).exists():
            errors["kind"] = "关联水体的地点必须保持河流或湖泊类型。"
        if self.map_layout_id and self.map_layout.region_id != self.region_id:
            errors["map_layout"] = "地点和底图必须属于同一区域。"
        if (self.x_ratio is None) != (self.y_ratio is None):
            errors["x_ratio"] = "必须成对填写相对坐标。"
        if self.x_ratio is not None and not self.map_layout_id:
            errors["map_layout"] = "图上点位必须关联具体底图版本。"
        if (self.latitude is None) != (self.longitude is None):
            errors["latitude"] = "必须成对填写经纬度。"
        if self.latitude is not None and not self.coordinate_system:
            errors["coordinate_system"] = "经纬度必须注明坐标系。"
        for field in ("x_ratio", "y_ratio", "latitude", "longitude"):
            value = getattr(self, field)
            if value is not None and not math.isfinite(value):
                errors[field] = "坐标必须是有限数字。"
        if errors:
            raise ValidationError(errors)

    def __str__(self):
        return self.name


class WaterBody(ValidatedModel):
    place = models.OneToOneField(Place, on_delete=models.PROTECT, related_name="water_body")
    description = models.TextField(blank=True)

    def clean(self):
        if self.pk and WaterBody.objects.filter(pk=self.pk).exclude(place_id=self.place_id).exists() and self.stations.exists():
            raise ValidationError({"place": "已有监测站关联的水体不能替换地点，请新建水体。"})
        if self.place_id and self.place.kind not in (Place.Kind.RIVER, Place.Kind.LAKE):
            raise ValidationError({"place": "水体必须关联河流或湖泊地点。"})

    def __str__(self):
        return self.place.name


class Station(ValidatedModel):
    class Kind(models.TextChoices):
        WATER = "water", "水环境"
        WEATHER = "weather", "气象"
        AIR = "air", "空气"

    region = models.ForeignKey(Region, on_delete=models.PROTECT, related_name="stations")
    place = models.ForeignKey(Place, on_delete=models.PROTECT, null=True, blank=True, related_name="stations")
    water_body = models.ForeignKey(WaterBody, on_delete=models.PROTECT, null=True, blank=True, related_name="stations")
    code = models.SlugField(unique=True)
    name = models.CharField(max_length=120)
    kind = models.CharField(max_length=20, choices=Kind.choices)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["code"]

    def clean(self):
        errors = {}
        if self.pk and Station.objects.filter(pk=self.pk).exclude(code=self.code, kind=self.kind, region_id=self.region_id, place_id=self.place_id, water_body_id=self.water_body_id).exists() and self.observations.exists():
            errors["kind"] = "已有观测的监测站不能改变代码、类型或所属地点/水体，请创建新站点。"
        if self.place_id and self.place.region_id != self.region_id:
            errors["place"] = "监测站与地点必须属于同一区域。"
        if self.water_body_id:
            if self.water_body.place.region_id != self.region_id:
                errors["water_body"] = "监测站与水体必须属于同一区域。"
            if self.kind != self.Kind.WATER:
                errors["kind"] = "只有水环境监测站可以关联水体。"
        if errors:
            raise ValidationError(errors)

    def __str__(self):
        return self.name


class Metric(ValidatedModel):
    code = models.SlugField(unique=True)
    name = models.CharField(max_length=80)
    unit = models.CharField(max_length=30)
    station_kind = models.CharField(max_length=20, choices=Station.Kind.choices)
    min_value = models.FloatField(null=True, blank=True)
    max_value = models.FloatField(null=True, blank=True)
    description = models.TextField(blank=True)

    class Meta:
        ordering = ["station_kind", "code"]

    def clean(self):
        if self.pk and Metric.objects.filter(pk=self.pk).exclude(code=self.code, unit=self.unit, station_kind=self.station_kind).exists() and self.observations.exists():
            raise ValidationError({"unit": "已有观测的指标不能改变代码、单位或适用站类型，请创建新指标。"})
        for field in ("min_value", "max_value"):
            value = getattr(self, field)
            if value is not None and not math.isfinite(value):
                raise ValidationError({field: "指标范围必须是有限数字。"})
        if self.min_value is not None and self.max_value is not None and self.min_value > self.max_value:
            raise ValidationError({"max_value": "最大值不能小于最小值。"})

    def __str__(self):
        return f"{self.name} ({self.unit})"


class DataSource(ValidatedModel):
    class Kind(models.TextChoices):
        API = "api", "API 数据"
        DATASET = "dataset", "历史数据集"
        SIMULATION = "simulation", "模拟数据"
        MANUAL = "manual", "人工录入"

    code = models.SlugField(unique=True)
    name = models.CharField(max_length=120)
    kind = models.CharField(max_length=20, choices=Kind.choices)
    license = models.CharField(max_length=500, blank=True)
    attribution = models.TextField(blank=True)
    original_url = models.URLField(blank=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["code"]

    def clean(self):
        if self.pk and DataSource.objects.filter(pk=self.pk).exclude(code=self.code, kind=self.kind).exists() and (self.observations.exists() or self.simulation_runs.exists()):
            raise ValidationError({"kind": "已有观测或批次的数据源不能修改代码或来源类型，请新增数据源。"})

    def __str__(self):
        return self.name


class SimulationScenario(ValidatedModel):
    code = models.SlugField(unique=True)
    name = models.CharField(max_length=120)
    seed = models.PositiveIntegerField(default=20260916)
    version = models.CharField(max_length=40, default="1")
    parameters = models.JSONField(default=dict, blank=True)
    description = models.TextField(blank=True)

    def __str__(self):
        return self.name

    def clean(self):
        if self.pk and SimulationScenario.objects.filter(pk=self.pk).exclude(code=self.code).exists() and self.runs.exists():
            raise ValidationError({"code": "已有运行批次的场景不能修改代码，请新增场景。"})
        if isinstance(self.parameters, dict):
            return
        raise ValidationError({"parameters": "场景参数必须是 JSON 对象。"})


class SimulationRun(ValidatedModel):
    key = models.CharField(max_length=64, unique=True)
    scenario = models.ForeignKey(SimulationScenario, on_delete=models.PROTECT, related_name="runs")
    source = models.ForeignKey(DataSource, on_delete=models.PROTECT, related_name="simulation_runs")
    start = models.DateTimeField()
    end = models.DateTimeField()
    seed = models.PositiveIntegerField()
    generator_version = models.CharField(max_length=40, default="1")
    parameters = models.JSONField(default=dict, blank=True)
    status = models.CharField(max_length=20, choices=[("running", "运行中"), ("succeeded", "成功"), ("failed", "失败")], default="running")
    counts = models.PositiveIntegerField(default=0)
    elapsed_ms = models.PositiveIntegerField(default=0)
    error_code = models.CharField(max_length=80, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
        permissions = [("maintain_simulation", "可以预览和执行模拟批次保留策略")]

    def clean(self):
        if self.source_id and self.source.kind != DataSource.Kind.SIMULATION:
            raise ValidationError({"source": "模拟运行必须使用模拟数据源。"})
        if any(value and timezone.is_naive(value) for value in [self.start, self.end]):
            raise ValidationError({"start": "模拟批次时间必须包含时区。"})
        if self.start and self.end and self.start >= self.end:
            raise ValidationError({"end": "结束时间必须晚于开始时间。"})

    def __str__(self):
        return f"{self.scenario.code} {self.start:%Y-%m-%d %H:%M}"


class Observation(ValidatedModel):
    class Quality(models.TextChoices):
        VALID = "valid", "有效"
        MISSING = "missing", "缺失"
        SUSPECT = "suspect", "可疑"

    station = models.ForeignKey(Station, on_delete=models.PROTECT, related_name="observations")
    metric = models.ForeignKey(Metric, on_delete=models.PROTECT, related_name="observations")
    value = models.FloatField(null=True, blank=True)
    observed_at = models.DateTimeField()
    ingested_at = models.DateTimeField(auto_now_add=True)
    source = models.ForeignKey(DataSource, on_delete=models.PROTECT, related_name="observations")
    quality_status = models.CharField(max_length=20, choices=Quality.choices, default=Quality.VALID)
    simulation_run = models.ForeignKey(SimulationRun, on_delete=models.PROTECT, null=True, blank=True, related_name="observations")
    dedupe_key = models.CharField(max_length=64, unique=True)

    class Meta:
        ordering = ["observed_at", "station__code", "metric__code"]
        indexes = [
            models.Index(fields=["station", "metric", "observed_at"], name="obs_station_metric_time"),
            models.Index(fields=["source", "observed_at"], name="obs_source_time"),
        ]
        constraints = [models.CheckConstraint(condition=(models.Q(value__isnull=True, quality_status="missing") | (~models.Q(quality_status="missing") & models.Q(value__isnull=False))), name="obs_missing_value_consistent")]

    @property
    def unit(self):
        return self.metric.unit

    def clean(self):
        errors = {}
        if self.observed_at and timezone.is_naive(self.observed_at):
            raise ValidationError({"observed_at": "观测时间必须包含时区。"})
        if self.value is None:
            if self.quality_status != self.Quality.MISSING:
                errors["quality_status"] = "空值必须标记为缺失。"
        elif not math.isfinite(self.value):
            errors["value"] = "观测值必须是有限数字，不接受 NaN 或 Infinity。"
        elif self.quality_status == self.Quality.MISSING:
            errors["value"] = "缺失记录的数值必须为空。"
        elif self.metric_id:
            if self.metric.min_value is not None and self.value < self.metric.min_value:
                errors["value"] = "观测值低于指标允许的下限。"
            if self.metric.max_value is not None and self.value > self.metric.max_value:
                errors["value"] = "观测值高于指标允许的上限。"
        if self.station_id and self.metric_id and self.station.kind != self.metric.station_kind:
            errors["metric"] = "指标不适用于该监测站类型。"
        if self.source_id:
            simulated = self.source.kind == DataSource.Kind.SIMULATION
            if simulated != bool(self.simulation_run_id):
                errors["simulation_run"] = "模拟观测必须关联模拟批次；其他来源不得关联模拟批次。"
            if self.simulation_run_id:
                if self.simulation_run.source_id != self.source_id:
                    errors["source"] = "观测来源必须与模拟批次来源相同。"
                if self.observed_at and not self.simulation_run.start <= self.observed_at < self.simulation_run.end:
                    errors["observed_at"] = "模拟观测时间必须处于批次时间范围内。"
        if errors:
            raise ValidationError(errors)


class SimulationRetentionPolicy(models.Model):
    """Singleton policy and common row lock for generation and cleanup."""

    id = models.PositiveSmallIntegerField(primary_key=True, default=1, editable=False)
    retain_days = models.PositiveIntegerField(default=30, validators=[MinValueValidator(30), MaxValueValidator(3650)])
    keep_successful = models.PositiveIntegerField(default=3, validators=[MinValueValidator(1), MaxValueValidator(100)])
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "模拟批次保留策略"
        verbose_name_plural = verbose_name
        constraints = [models.CheckConstraint(condition=models.Q(id=1, retain_days__gte=30, retain_days__lte=3650, keep_successful__gte=1, keep_successful__lte=100), name="simulation_policy_limits")]

    def save(self, *args, **kwargs):
        self.full_clean()
        return super().save(*args, **kwargs)

    def __str__(self):
        return f"保留 {self.retain_days} 天 / 每来源场景至少 {self.keep_successful} 个成功批次"


class SimulationCleanupPreview(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.CASCADE)
    fingerprint = models.CharField(max_length=64)
    policy = models.JSONField(default=dict)
    candidate_ids = models.JSONField(default=list)
    observation_count = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField()
    consumed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        verbose_name = "模拟批次清理预览"
        verbose_name_plural = verbose_name
