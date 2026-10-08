import { describe, expect, it } from 'vitest';
import {
  FORM_TOP_PAD,
  NEAR_BOTTOM_SLACK,
  SCROLL_RESTORE_SLACK,
  anchoredScrollTop,
  effectiveLastRole,
  formTopScrollOffset,
  isNearBottom,
  replyBelowFormId,
  restoreScrollTop,
  scrollBehaviorFor,
  scrollHoldAction,
  scrollOffsetOf,
  scrollTarget,
  shouldAutoScroll,
  type HeldScroll,
  type HoldInput,
  type ReplyBelowInput,
  type ScrollDecisionInput,
} from '../autoScroll';

const metrics = (scrollTop: number, clientHeight = 500, scrollHeight = 2000) =>
  ({ scrollTop, clientHeight, scrollHeight });

describe('near-bottom detection', () => {
  it('counts the exact bottom and anything inside the slack as at the bottom', () => {
    expect(isNearBottom(metrics(1500))).toBe(true);          // exactly at bottom
    expect(isNearBottom(metrics(1500 - NEAR_BOTTOM_SLACK))).toBe(true); // edge of slack
    expect(isNearBottom(metrics(1450))).toBe(true);
  });

  it('is false once the reader has scrolled up past the slack', () => {
    expect(isNearBottom(metrics(1379))).toBe(false);
    expect(isNearBottom(metrics(0))).toBe(false);
  });

  it('treats content shorter than the viewport as at the bottom', () => {
    expect(isNearBottom(metrics(0, 500, 400))).toBe(true);
  });

  it('honours a custom slack', () => {
    expect(isNearBottom(metrics(1000), 500)).toBe(true);
    expect(isNearBottom(metrics(1000), 10)).toBe(false);
  });
});

describe('auto-scroll policy', () => {
  it('follows new content while the reader is at the bottom', () => {
    expect(shouldAutoScroll(true, 'assistant')).toBe(true);
    expect(shouldAutoScroll(true, undefined)).toBe(true);
  });

  it('never yanks a reader who scrolled up to read history', () => {
    expect(shouldAutoScroll(false, 'assistant')).toBe(false);
    expect(shouldAutoScroll(false, 'system')).toBe(false);
    expect(shouldAutoScroll(false, null)).toBe(false);
  });

  it("always follows the reader's OWN send, wherever they were scrolled", () => {
    expect(shouldAutoScroll(false, 'user')).toBe(true);
    expect(shouldAutoScroll(true, 'user')).toBe(true);
  });
});

describe('scroll target', () => {
  const at = (over: Partial<ScrollDecisionInput> = {}): ScrollDecisionInput => ({
    nearBottom: true,
    lastMessageRole: 'assistant',
    hasForm: false,
    formRound: 0,
    seenFormRound: 0,
    ...over,
  });

  it('sends a typed user turn to the bottom, wherever the reader was', () => {
    expect(scrollTarget(at({ lastMessageRole: 'user' }))).toBe('bottom');
    expect(scrollTarget(at({ lastMessageRole: 'user', nearBottom: false }))).toBe('bottom');
  });

  it('anchors the TOP of a form that just appeared', () => {
    expect(scrollTarget(at({ hasForm: true, formRound: 1, seenFormRound: 0 })))
      .toBe('form-top');
  });

  it('anchors a REPLACED form too - any new round counts', () => {
    expect(scrollTarget(at({ hasForm: true, formRound: 4, seenFormRound: 3 })))
      .toBe('form-top');
  });

  it('anchors a form that arrived on the reader\'s own action even scrolled up', () => {
    expect(scrollTarget(at({
      nearBottom: false, lastMessageRole: 'user',
      hasForm: true, formRound: 1, seenFormRound: 0,
    }))).toBe('form-top');
  });

  it('does NOT re-anchor a re-render of the same form (typing in it)', () => {
    expect(scrollTarget(at({ hasForm: true, formRound: 2, seenFormRound: 2 })))
      .toBe('bottom');
    expect(scrollTarget(at({
      nearBottom: false, hasForm: true, formRound: 2, seenFormRound: 2,
    }))).toBeNull();
  });

  it('leaves a scrolled-up reader alone for ordinary assistant traffic', () => {
    expect(scrollTarget(at({ nearBottom: false }))).toBeNull();
    expect(scrollTarget(at({ nearBottom: false, lastMessageRole: 'system' }))).toBeNull();
  });

  it('does not chase a form top once the form is gone', () => {
    expect(scrollTarget(at({ hasForm: false, formRound: 5, seenFormRound: 4 })))
      .toBe('bottom');
  });

  it('follows the bottom for new content while the reader is there', () => {
    expect(scrollTarget(at())).toBe('bottom');
  });

  /**
   * THE EIB FIX-ROUND SCROLL DEFECT. Reproduced on staging 3 of 3 on
   * 2026-08-13: scrollTop 7360 -> 0, 6106 -> 0, 6345 -> 1245. The fix round
   * bumps the round counter, the old rule read that as a form appearing, and
   * the form's top on EIB is the top of the transcript.
   */
  describe('a contract replacing its predecessor under the SAME form id', () => {
    const redraw = (over: Partial<ScrollDecisionInput> = {}) => at({
      hasForm: true, formRound: 4, seenFormRound: 3,
      formId: 'eib-fix', anchoredFormId: 'eib-fix', ...over,
    });

    it('holds the position of a reader who is working inside the form', () => {
      // The exact EIB state: mid-form, scrolled well up, a system verdict line
      // was the last thing said. Nothing may move the view.
      expect(scrollTarget(redraw({ nearBottom: false, lastMessageRole: 'system' })))
        .toBeNull();
    });

    it('does not re-anchor the form top even when the reader is at the bottom', () => {
      expect(scrollTarget(redraw())).toBe('bottom');
    });

    it('still anchors a form arriving under a DIFFERENT id', () => {
      expect(scrollTarget(redraw({ formId: 'eib-review' }))).toBe('form-top');
    });

    it('still anchors the FIRST form, which has no predecessor', () => {
      expect(scrollTarget(redraw({ formRound: 1, seenFormRound: 0, anchoredFormId: null })))
        .toBe('form-top');
    });

    it('leaves callers that pass no ids on the old behaviour', () => {
      expect(scrollTarget(at({ hasForm: true, formRound: 4, seenFormRound: 3 })))
        .toBe('form-top');
    });
  });
});

/**
 * The third mechanism behind the jump, and the one that kept rounds 1 and 3
 * moving after the hold was in place: a form submit sends the envelope as a
 * USER message, which then stays the last message for the whole turn, so every
 * commit until the agent replies re-read it as a fresh send. Round 3 landed on
 * 12068 of 12068 - the exact bottom - long after the send.
 */
describe("the reader's own send is spent once", () => {
  it('follows a send that has not been followed yet', () => {
    expect(effectiveLastRole('user', 'm7', null)).toBe('user');
    expect(effectiveLastRole('user', 'm7', 'm6')).toBe('user');
  });

  it('stops following the SAME send on every later commit of the turn', () => {
    expect(effectiveLastRole('user', 'm7', 'm7')).toBe('assistant');
  });

  it('leaves every other role exactly as it found it', () => {
    expect(effectiveLastRole('assistant', 'm7', 'm7')).toBe('assistant');
    expect(effectiveLastRole('system', 'm7', 'm7')).toBe('system');
    expect(effectiveLastRole(undefined, undefined, 'm7')).toBeUndefined();
    expect(effectiveLastRole(null, null, null)).toBeNull();
  });

  it('leaves a caller that passes no id on the old behaviour', () => {
    expect(effectiveLastRole('user')).toBe('user');
  });

  it('the spent send no longer drags a scrolled-up reader down', () => {
    // The whole point, expressed against the policy it feeds.
    expect(shouldAutoScroll(false, effectiveLastRole('user', 'm7', 'm7'))).toBe(false);
    expect(shouldAutoScroll(false, effectiveLastRole('user', 'm7', 'm6'))).toBe(true);
  });
});

/**
 * THE HOLD - what actually fixes the EIB fix-round jump. Measured on
 * staging-v16 with the redraw rule already live: 7360 -> 0, 6106 -> 65,
 * 6371 -> 12068. The third pair is the diagnosis: 12068 was the EXACT bottom
 * of the transcript, so nothing was anchoring the view, it was following the
 * bottom of a transcript the collapsed form had temporarily emptied.
 */
describe('the scroll hold across a form collapse', () => {
  const at = (over: Partial<HoldInput> = {}): HoldInput => ({
    wasShown: true, isShown: true, formId: 'eib-fix', heldFormId: null,
    busy: false, contentCanHold: false, ...over,
  });

  it('arms as the form block leaves the DOM mid-turn', () => {
    expect(scrollHoldAction(at({ isShown: false, busy: true }))).toBe('arm');
  });

  it('does nothing at all when there is no hold and nothing is leaving', () => {
    expect(scrollHoldAction(at())).toBe('none');
    expect(scrollHoldAction(at({ wasShown: false }))).toBe('none');
  });

  it('waits while the turn runs and the form has not come back', () => {
    // wasShown is already false here: the arm happened on the previous render.
    expect(scrollHoldAction(at({
      wasShown: false, isShown: false, busy: true, heldFormId: 'eib-fix',
    }))).toBe('wait');
  });

  it('arms only ONCE - a second arm would record the clamped offset', () => {
    // The value the hold exists to discard is exactly the post-clamp one.
    expect(scrollHoldAction(at({
      isShown: false, busy: true, heldFormId: 'eib-fix',
    }))).toBe('wait');
  });

  it('waits when the form is back but has not painted tall enough yet', () => {
    // The commit where the block re-enters the DOM is not always the commit
    // where it has its full height.
    expect(scrollHoldAction(at({
      heldFormId: 'eib-fix', busy: true, contentCanHold: false,
    }))).toBe('wait');
  });

  it('restores once the same form is back and the content can hold it', () => {
    expect(scrollHoldAction(at({
      heldFormId: 'eib-fix', contentCanHold: true,
    }))).toBe('restore');
  });

  it('drops the hold when the turn SETTLES on a different form', () => {
    // The fix round passed and the review arrived: a different screen, whose
    // own anchor rule should own the view.
    expect(scrollHoldAction(at({
      formId: 'eib-review', heldFormId: 'eib-fix', contentCanHold: true, busy: false,
    }))).toBe('drop');
  });

  it('holds THROUGH a mid-turn interstitial and restores when the form returns', () => {
    // EIB puts a progress contract on screen while it repairs rows, then comes
    // back to the same fix form. This is the round-1 defect: measured 7360 -> 0
    // on the round that repaired 3 rows, while the rounds that repaired none
    // held exactly. A waypoint is not a destination.
    expect(scrollHoldAction(at({
      formId: 'eib-progress', heldFormId: 'eib-fix', busy: true, contentCanHold: false,
    }))).toBe('wait');
    expect(scrollHoldAction(at({
      formId: 'eib-fix', heldFormId: 'eib-fix', busy: true, contentCanHold: true,
    }))).toBe('restore');
  });

  it('drops the hold when the turn ends with no form at all', () => {
    expect(scrollHoldAction(at({
      formId: null, isShown: false, heldFormId: 'eib-fix',
    }))).toBe('drop');
  });

  /**
   * THE SHRINKING RE-RENDER (1.21.1). This used to assert `drop`, and dropping
   * is not neutral - it leaves the reader wherever the collapse-era clamp put
   * them, which is the top of the transcript. A fix round that fixes rows
   * removes those blocks from the next fix form, so "the form came back
   * shorter" is the ORDINARY outcome, and the hold was being discarded whole
   * over the last few hundred pixels of it.
   */
  it('restores as far as it reaches when the form comes back SHORTER', () => {
    expect(scrollHoldAction(at({
      heldFormId: 'eib-fix', busy: false, contentCanHold: false,
    }))).toBe('restore');
  });

  it('still drops rather than restoring onto a screen that is not the form', () => {
    // The relaxation is about HEIGHT only: a settled different form is still a
    // different screen, whether or not it could hold the offset.
    expect(scrollHoldAction(at({
      formId: 'eib-review', heldFormId: 'eib-fix', busy: false, contentCanHold: false,
    }))).toBe('drop');
  });
});

/**
 * THE ANCHORED OFFSET - what makes a shrunken restore land somewhere useful.
 *
 * A raw offset describes a screen that the re-render has already destroyed. The
 * distance INTO the form survives it, so the hold records the form's top
 * alongside the reader's offset and re-adds it against wherever the replacement
 * form now starts.
 */
describe('the anchored restore target', () => {
  const held = (over: Partial<HeldScroll> = {}): HeldScroll => ({
    top: 6371, formId: 'eib-fix', formTop: 1200, ...over,
  });

  it('keeps the reader the same distance into the form', () => {
    // The form came back 300px lower (a verdict message announced the round).
    expect(anchoredScrollTop(held(), 1500)).toBe(6671);
    // ...and 300px higher.
    expect(anchoredScrollTop(held(), 900)).toBe(6071);
  });

  it('is unchanged when the form did not move', () => {
    expect(anchoredScrollTop(held(), 1200)).toBe(6371);
  });

  it('falls back to the raw offset when the form was not measurable', () => {
    // -1 is the sentinel from scrollOffsetOf; jsdom takes this path throughout.
    expect(anchoredScrollTop(held({ formTop: -1 }), 1500)).toBe(6371);
    expect(anchoredScrollTop(held(), -1)).toBe(6371);
  });

  it('never asks for a negative offset', () => {
    expect(anchoredScrollTop(held({ top: 1300, formTop: 1200 }), 0)).toBe(100);
    expect(anchoredScrollTop(held({ top: 1100, formTop: 1200 }), 0)).toBe(0);
  });

  /**
   * The residual the browser spec reproduced, end to end: the reader is 5171px
   * into a form, the round fixes rows, the replacement is 2000px shorter, and
   * the transcript can no longer hold the old offset. `drop` left them at the
   * clamp - 65px, the top. Anchored-and-clamped puts them at the bottom of the
   * form they are working in, which is where the remaining rows are.
   */
  it('lands the shrunken case near the reader instead of at the top', () => {
    const target = anchoredScrollTop(held(), 1200);
    expect(restoreScrollTop(target, 65, 4300)).toBe(4300);
  });

  /**
   * The measurement itself, driven through stubs rather than the DOM: jsdom
   * lays nothing out, so `getClientRects` there is empty for EVERY element and
   * a real-element test could only ever exercise the -1 branch. The clamp this
   * whole fix is about is a browser behaviour jsdom does not have either - the
   * eib-chaos scroll watch is the acceptance test, not this file.
   */
  it('measures an element against its scroller, and reports an absent box', () => {
    const container = {
      scrollTop: 100, getBoundingClientRect: () => ({ top: 10 }),
    } as unknown as HTMLElement;
    const laidOut = {
      getClientRects: () => [{}], getBoundingClientRect: () => ({ top: 210 }),
    } as unknown as HTMLElement;
    const hidden = {
      getClientRects: () => [], getBoundingClientRect: () => ({ top: 0 }),
    } as unknown as HTMLElement;
    expect(scrollOffsetOf(container, laidOut)).toBe(300);
    expect(scrollOffsetOf(container, hidden)).toBe(-1);
  });
});

describe('scroll anchoring across a redraw', () => {
  it('puts the reader back where a clamp took them from', () => {
    // Round 1 of the live trace: 7360 destroyed, content can still hold it.
    expect(restoreScrollTop(7360, 0, 11879)).toBe(7360);
  });

  it('restores only as far as the new content can hold', () => {
    expect(restoreScrollTop(7360, 0, 5000)).toBe(5000);
  });

  it('leaves a position that was not clamped alone', () => {
    expect(restoreScrollTop(7360, 7360, 11879)).toBeNull();
    expect(restoreScrollTop(7360, 7360 - SCROLL_RESTORE_SLACK, 11879)).toBeNull();
  });

  /**
   * This used to assert the opposite - "never drags the reader DOWN, a clamp
   * only ever moves them up" - and the assumption was disproven by measurement.
   * The BROWSER'S OWN scroll anchoring moves the view down by the height of the
   * content re-inserted above the anchor: scrollTop went 209 -> 12068 with no
   * script involved, landing on the exact bottom of the transcript, and the
   * one-directional restore declined to correct it.
   */
  it('corrects a view the browser anchored DOWNWARDS too', () => {
    expect(restoreScrollTop(6293, 12068, 12212)).toBe(6293);
    expect(restoreScrollTop(1000, 5000, 11879)).toBe(1000);
  });

  it('says nothing about a transcript that was at the top, or cannot scroll', () => {
    expect(restoreScrollTop(0, 0, 11879)).toBeNull();
    expect(restoreScrollTop(7360, 0, 0)).toBeNull();
  });
});

describe('form-top offset', () => {
  it('parks the form top one pad below the container top', () => {
    // Container top at 100, form top at 340, already scrolled 200 down:
    // the form sits 240px into the viewport, so scroll 240 - pad further.
    expect(formTopScrollOffset(200, 100, 340)).toBe(200 + 240 - FORM_TOP_PAD);
  });

  it('scrolls UP when the form is above the viewport top', () => {
    expect(formTopScrollOffset(500, 100, 60)).toBe(500 - 40 - FORM_TOP_PAD);
  });

  it('never asks for a negative offset', () => {
    expect(formTopScrollOffset(0, 100, 20)).toBe(0);
  });

  it('honours a custom pad', () => {
    expect(formTopScrollOffset(200, 100, 340, 0)).toBe(440);
  });
});

describe('motion preference', () => {
  it('animates by default and jumps instantly under reduced motion', () => {
    expect(scrollBehaviorFor(false)).toBe('smooth');
    expect(scrollBehaviorFor(true)).toBe('auto');
  });
});

/**
 * THE ANSWER NOBODY SEES. A form anchored mid-transcript pushes everything said
 * afterwards below itself, and these forms run several viewports tall, so a
 * reply to a question asked mid-form lands off screen with no signal at all.
 * The affordance points at it; it never moves the view on its own.
 */
describe('replyBelowFormId', () => {
  /** A reply that landed below a form the reader is looking at, off screen. */
  const hidden = (over: Partial<ReplyBelowInput> = {}): ReplyBelowInput => ({
    formShown: true,
    formAnchorIndex: 2,
    lastIndex: 5,
    lastRole: 'assistant',
    lastId: 'm-5',
    streaming: false,
    nearBottom: false,
    ...over,
  });

  it('points at a reply that landed below the form, off screen', () => {
    expect(replyBelowFormId(hidden())).toBe('m-5');
  });

  it('a system line counts too - a verdict note is a reply', () => {
    expect(replyBelowFormId(hidden({ lastRole: 'system' }))).toBe('m-5');
  });

  it('says nothing when the reader can already see it', () => {
    expect(replyBelowFormId(hidden({ nearBottom: true }))).toBeNull();
  });

  it('says nothing while the turn is still running', () => {
    // The thinking indicator is the signal in that window, and a half-streamed
    // bubble is not yet a reply.
    expect(replyBelowFormId(hidden({ streaming: true }))).toBeNull();
  });

  it('says nothing with no form block on screen', () => {
    // Without a form in the way the ordinary bottom-follow already covers it.
    expect(replyBelowFormId(hidden({ formShown: false }))).toBeNull();
  });

  it('says nothing when the form sits at the END of the stream', () => {
    // -1 is the no-anchor case: nothing renders below the form at all.
    expect(replyBelowFormId(hidden({ formAnchorIndex: -1 }))).toBeNull();
    // And the same when the last message IS the form's own anchor.
    expect(replyBelowFormId(hidden({ formAnchorIndex: 5, lastIndex: 5 }))).toBeNull();
  });

  it("says nothing about the reader's own message", () => {
    expect(replyBelowFormId(hidden({ lastRole: 'user' }))).toBeNull();
  });
});
