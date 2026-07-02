import { Composition } from "remotion";
import { Test } from "./Test";
import { MotionComic, type MotionComicProps } from "./MotionComic";
import { FPS } from "../lib/timeline";
import { DELIVERY_SIZE, type Delivery, type Project } from "../lib/schema";

const emptyProject = {
  meta: { delivery: "vertical", bgm_track: null, target_duration_sec: 22 },
  shots: [],
} as unknown as Project;

const defaultProps: MotionComicProps = {
  project: emptyProject,
  assetBase: "",
  timeline: { fps: FPS, totalSec: 1, shots: [], cards: [] },
};

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="Test"
        component={Test}
        durationInFrames={30}
        fps={30}
        width={640}
        height={360}
      />
      <Composition
        id="MotionComic"
        component={MotionComic}
        defaultProps={defaultProps}
        calculateMetadata={({ props }) => {
          const delivery = (props.project?.meta?.delivery ?? "vertical") as Delivery;
          const size = DELIVERY_SIZE[delivery] ?? DELIVERY_SIZE.vertical;
          const fps = props.timeline?.fps ?? FPS;
          const total = props.timeline?.totalSec ?? 1;
          return {
            durationInFrames: Math.max(1, Math.round(total * fps)),
            width: size.w,
            height: size.h,
            fps,
          };
        }}
      />
    </>
  );
};
