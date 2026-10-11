// Editorial covers supplied by the user on 2026-10-09. Match stable content IDs,
// never card position: filtering or pagination must not move a photo to another story.
const covers = [
  {
    id: "0aae17d9-e3e4-4de5-aefc-d27e53afc0f9",
    kind: "content",
    file: "sunflower.jpg",
    alt: "夕阳下的向日葵",
    position: "50% 50%",
  },
  {
    id: "1e282135-94b8-4e0c-a23c-b95f53bd27c2",
    kind: "content",
    file: "campus-rain.jpg",
    alt: "雨水沿路边排水口流动",
    position: "50% 50%",
  },
  {
    id: "2d9bac30-8645-4491-9018-904f610ed63d",
    kind: "content",
    file: "flowers-by-lake.jpg",
    alt: "湖边枝头的白色花朵",
    position: "50% 50%",
  },
  {
    id: "c50b58e6-9fcd-43fd-9284-b083582fc5e3",
    kind: "route",
    file: "wudadao.jpg",
    alt: "五大道街景配图",
    position: "50% 40%",
  },
  {
    id: "804bd241-de7f-4561-9dcb-802b2c64f355",
    kind: "route",
    file: "beining-park.jpg",
    alt: "北宁公园湖景配图",
    position: "50% 40%",
  },
  {
    id: "eff43584-a13f-4d11-9f45-ef87ee8b77bb",
    kind: "route",
    file: "haihe-evening.jpg",
    alt: "海河傍晚景观配图",
    position: "50% 48%",
  },
].map((row, rank) => ({ ...row, rank, src: "/assets/learn/" + row.file }));

export function contentCover(item, kind = "content") {
  return (
    covers.find((cover) => cover.kind === kind && cover.id === item?.id) || null
  );
}

export function featuredContents(items, kind = "content") {
  return [...items].sort(
    (a, b) =>
      (contentCover(a, kind)?.rank ?? Number.MAX_SAFE_INTEGER) -
      (contentCover(b, kind)?.rank ?? Number.MAX_SAFE_INTEGER),
  );
}
